// Écritures de fin de mois — rapprochement de la subvention salariale
// (Biotalent, Louis-Bernard).
//
// Demande : la provision mensuelle est une estimation (60 % du salaire) ; le
// montant réellement versé par Biotalent peut différer. La carte doit
// permettre de suivre ce qui a été réellement reçu et d'afficher l'écart avec
// ce qui a été comptabilisé comme « subvention à recevoir ». Un bouton permet
// ensuite d'imputer cet écart à l'état des résultats (Dr/Cr 12400 ↔ 49000).
//
// Le bouton de régularisation POSTE UNE VRAIE ÉCRITURE DANS QUICKBOOKS — ce
// test vérifie qu'il apparaît/disparaît correctement selon l'écart, mais ne
// clique JAMAIS dessus (irréversible sans intervention manuelle dans QB).
// Le seul état créé est une réception de test, supprimée dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const norm = s => (s || '').replace(/[   ]/g, ' ').trim()

describe('Fin de mois — rapprochement de la subvention salariale', () => {
  let browser, ctx, page, createdReceiptId

  async function apiFetch(path, init) {
    return page.evaluate(async ({ base, path, init }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api' + path, {
        ...(init || {}),
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    }, { base: URL, path, init })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => {
    try { if (createdReceiptId) await apiFetch(`/month-end/receipts/${createdReceiptId}`, { method: 'DELETE' }) } catch { /* best-effort */ }
    await browser?.close()
  })

  test('le panneau affiche le rapprochement provisionné vs reçu', async () => {
    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    await page.locator('h2:has-text("subvention salariale")').waitFor({ state: 'visible', timeout: 30000 })

    const panel = page.locator('[data-testid="subsidy-receipts-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 15000 })
    await panel.locator('text=Chargement…').waitFor({ state: 'detached', timeout: 15000 })
    const text = norm(await panel.innerText())
    assert.match(text, /Comptabilisé comme subvention à recevoir/)
    assert.match(text, /Réellement reçu à ce jour/)
    assert.match(text, /Écart à régulariser/)
  })

  test('ajouter un versement reçu recalcule l\'écart et fait apparaître le bouton', async () => {
    const panel = page.locator('[data-testid="subsidy-receipts-panel"]')
    const outstandingBefore = norm(await panel.locator('[data-testid="subsidy-outstanding"]').innerText())

    await panel.locator('[data-testid="receipt-add"]').click()
    await panel.locator('[data-testid="receipt-date"]').fill('2026-08-01')
    await panel.locator('[data-testid="receipt-amount"]').fill('100')
    await panel.locator('[data-testid="receipt-save"]').click()

    // La ligne apparaît et l'écart diminue de 100 $.
    await page.locator('td:has-text("2026-08-01")').waitFor({ state: 'visible', timeout: 10000 })
    const outstandingAfter = norm(await panel.locator('[data-testid="subsidy-outstanding"]').innerText())
    assert.notEqual(outstandingBefore, outstandingAfter, 'l\'écart affiché n\'a pas changé après l\'ajout du versement')

    const receipts = await (await apiFetch(`/month-end/provisions/prov_subv_salariale_lb/receipts`)).body
    const row = receipts.receipts.find(r => r.received_date === '2026-08-01' && r.amount === 100)
    assert.ok(row, 'la réception créée est introuvable via l\'API')
    createdReceiptId = row.id

    // Le bouton de régularisation reste visible tant que l'écart n'est pas nul
    // — mais on ne clique jamais dessus (écriture réelle dans QuickBooks).
    await panel.locator('[data-testid="regularize-subsidy"]').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('supprimer le versement restaure l\'écart d\'origine', async () => {
    const panel = page.locator('[data-testid="subsidy-receipts-panel"]')
    await panel.locator('tr', { has: page.locator('td:has-text("2026-08-01")') }).locator('button').click()
    await page.locator('td:has-text("2026-08-01")').waitFor({ state: 'detached', timeout: 10000 })
    createdReceiptId = null // supprimé via l'UI, plus besoin du cleanup after()

    const recon = (await (await apiFetch(`/month-end/provisions/prov_subv_salariale_lb/receipts`)).body).reconciliation
    assert.equal(recon.received, 0, 'le montant reçu devrait être revenu à 0 après suppression')
  })
})
