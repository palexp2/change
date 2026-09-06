// Écritures de fin de mois — détection automatique des versements de la
// subvention Biotalent dans le rapprochement bancaire.
//
// Demande (2026-08-09) : Charles ne voulait plus noter à la main la date et le
// montant de chaque versement reçu — l'app doit les détecter elle-même dans le
// relevé bancaire. La provision porte maintenant `config.bank_match_label`
// (« Biotalent ») ; toute transaction créditrice dont le libellé contient ce
// mot crée automatiquement une ligne dans le panneau de réception, source
// « banque ». Déclenché à chaque import bancaire (voir services/bankReconciliation.js
// → detectBankReceipts()) + bouton manuel « Rechercher dans le relevé bancaire ».
//
// Ce test crée un compte bancaire et une transaction JETABLES (via l'API, pour
// aller vite) pour vérifier le chemin complet — jamais de vraie transaction
// bancaire touchée. Nettoyage intégral dans after() : transaction, réception
// détectée, compte bancaire.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const norm = s => (s || '').replace(/[   ]/g, ' ').trim()
const PROVISION_ID = 'prov_subv_salariale_lb'

describe('Fin de mois — détection bancaire automatique de la subvention Biotalent', () => {
  let browser, ctx, page, bankAccountId

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
    try { if (bankAccountId) await apiFetch(`/bank/accounts/${bankAccountId}`, { method: 'DELETE' }) } catch { /* best-effort */ }
    await browser?.close()
  })

  test('importer une transaction « BIOTALENT » crée une réception détectée automatiquement', async () => {
    const created = await apiFetch('/bank/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'ZZ Test agent — compte bancaire jetable' }),
    })
    assert.equal(created.status, 201, `création du compte refusée : ${JSON.stringify(created.body)}`)
    bankAccountId = created.body.id

    const imported = await apiFetch(`/bank/accounts/${bankAccountId}/import`, {
      method: 'POST',
      body: JSON.stringify({ rows: [{ txn_date: '2026-08-05', description: 'VIR BIOTALENT SUBVENTION SALARIALE', amount: 1500 }] }),
    })
    assert.equal(imported.status, 201, `import refusé : ${JSON.stringify(imported.body)}`)

    // L'import déclenche detectBankReceipts() — la réception doit exister sans
    // aucune action supplémentaire (c'est tout le point de la demande).
    const receipts = (await apiFetch(`/month-end/provisions/${PROVISION_ID}/receipts`)).body
    const row = receipts.receipts.find(r => r.amount === 1500 && r.received_date === '2026-08-05')
    assert.ok(row, 'la réception détectée automatiquement est absente')
    assert.equal(row.source, 'banque')
    assert.match(row.note, /BIOTALENT/)
  })

  test('le panneau affiche la ligne détectée avec son badge, dans la vraie UI', async () => {
    await page.goto(URL + '/fin-de-mois', { waitUntil: 'domcontentloaded' })
    await page.locator('h2:has-text("subvention salariale")').waitFor({ state: 'visible', timeout: 30000 })
    const panel = page.locator('[data-testid="subsidy-receipts-panel"]')
    await panel.locator('text=Chargement…').waitFor({ state: 'detached', timeout: 15000 })

    const row = panel.locator('tr', { has: page.locator('td:has-text("2026-08-05")') })
    await row.waitFor({ state: 'visible', timeout: 10000 })
    const text = norm(await row.innerText())
    assert.match(text, /détecté dans le relevé/)
    assert.match(text, /BIOTALENT/)

    // Le bouton de recherche manuelle est visible (bank_match_label configuré).
    await panel.locator('[data-testid="scan-bank-receipts"]').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('supprimer la ligne détectée (faux positif) ne la fait pas revenir au scan suivant', async () => {
    const panel = page.locator('[data-testid="subsidy-receipts-panel"]')
    await panel.locator('tr', { has: page.locator('td:has-text("2026-08-05")') }).locator('button').click()
    await page.locator('td:has-text("2026-08-05")').waitFor({ state: 'detached', timeout: 10000 })

    // Relance explicite de la détection via le bouton — la ligne supprimée ne
    // doit jamais réapparaître (contrainte UNIQUE sur bank_transaction_id,
    // vérifiée sans filtre deleted_at).
    await panel.locator('[data-testid="scan-bank-receipts"]').click()
    await page.waitForTimeout(1500)
    assert.equal(await page.locator('td:has-text("2026-08-05")').count(), 0, 'la réception supprimée est revenue après un nouveau scan')

    const recon = (await (await apiFetch(`/month-end/provisions/${PROVISION_ID}/receipts`)).body).reconciliation
    assert.equal(recon.received, 0, 'le montant reçu devrait être revenu à 0 après suppression du faux positif')
  })
})
