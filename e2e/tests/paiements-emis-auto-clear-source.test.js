// /paiements-emis — traçabilité du cochage « passé à la banque » (cleared_source).
//
// Le cochage peut maintenant venir de trois sources : l'utilisateur (manual),
// l'appariement au relevé importé (bank) ou la disparition de la ligne du
// fichier « Maintien du solde disponible BNC » (sheet — détection automatique).
// Vérifie côté UI + API :
//   1. le pill d'un paiement en attente annonce la détection automatique ;
//   2. cliquer « A passé » coche avec cleared_source = 'manual' ;
//   3. un paiement coché par le fichier (source 'sheet') l'affiche dans le pill ;
//   4. décocher remet cleared_source ET sheet_seen_at à NULL (l'automatisme ne
//      re-cochera pas par-dessus la décision de l'utilisateur).
//
// Aucun record réel n'est touché : paiements jetables marqués E2E sur un compte
// hors projection (« E2E Compte »), supprimés dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const PENDING_LABEL = `E2E AutoClear ${STAMP}`
const SHEET_LABEL = `E2E AutoCleared ${STAMP}`

describe('Paiements émis — sources du cochage « passé à la banque »', () => {
  let browser, ctx, page
  const createdIds = []
  let pendingId, sheetId

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  // Pas de GET /payments/:id — on relit la liste et on y retrouve le paiement.
  const getPayment = async (id) => {
    const r = await apiFetch('/treasury/payments?status=all&limit=500')
    assert.equal(r.status, 200)
    const p = (r.body || []).find(x => x.id === id)
    assert.ok(p, `Paiement ${id} absent de la liste`)
    return p
  }

  // L'UI sauvegarde en autosave : on valide l'état via l'API, pas le DOM.
  const pollPayment = async (id, predicate, what) => {
    for (let i = 0; i < 30; i++) {
      const p = await getPayment(id)
      if (predicate(p)) return p
      await page.waitForTimeout(500)
    }
    assert.fail(`Paiement ${id} : ${what} jamais observé via l'API`)
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Deux paiements jetables sur un compte hors projection (≠ BNC CAD) :
    // un en attente, un déjà coché « par le fichier » (cleared_source: sheet).
    let r = await apiFetch('/treasury/payments', {
      method: 'POST',
      body: JSON.stringify({
        payment_date: '2026-08-01', direction: 'out', amount: 3.21,
        account: 'E2E Compte', label: PENDING_LABEL, method: 'autre',
      }),
    })
    assert.equal(r.status, 201)
    pendingId = r.body.id
    createdIds.push(pendingId)

    r = await apiFetch('/treasury/payments', {
      method: 'POST',
      body: JSON.stringify({
        payment_date: '2026-08-01', direction: 'out', amount: 4.32,
        account: 'E2E Compte', label: SHEET_LABEL, method: 'autre',
        cleared_at: new Date().toISOString(), cleared_source: 'sheet',
      }),
    })
    assert.equal(r.status, 201)
    sheetId = r.body.id
    createdIds.push(sheetId)
  })

  after(async () => {
    for (const id of createdIds) {
      await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    await browser?.close()
  })

  test('le pill « A passé » annonce la détection automatique', async () => {
    await page.goto(URL + '/paiements-emis', { waitUntil: 'domcontentloaded' })
    const pill = page.locator(`[data-testid="payment-cleared-${pendingId}"]`)
    await pill.waitFor({ timeout: 15000 })
    assert.equal((await pill.textContent()).trim(), 'A passé')
    assert.equal(await pill.getAttribute('aria-pressed'), 'false')
    assert.match(await pill.getAttribute('title'), /Coché automatiquement dès que QuickBooks montre le mouvement/)
  })

  test('cliquer « A passé » coche avec cleared_source = manual', async () => {
    await page.click(`[data-testid="payment-cleared-${pendingId}"]`)
    const p = await pollPayment(pendingId, x => !!x.cleared_at, 'cleared_at posé')
    assert.equal(p.cleared_source, 'manual')
  })

  test('un paiement coché par le fichier l\'affiche dans le pill', async () => {
    // Les deux paiements sont maintenant passés : onglet « Passés ».
    await page.click('button:has-text("Passés")')
    const pill = page.locator(`[data-testid="payment-cleared-${sheetId}"]`)
    await pill.waitFor({ timeout: 15000 })
    assert.equal((await pill.textContent()).trim(), 'A passé')
    assert.equal(await pill.getAttribute('aria-pressed'), 'true')
    assert.match(await pill.getAttribute('title'),
      /coché automatiquement \(retiré du fichier « Maintien du solde disponible BNC »\)/)
  })

  test('décocher remet cleared_source et sheet_seen_at à NULL', async () => {
    await page.click(`[data-testid="payment-cleared-${sheetId}"]`)
    const p = await pollPayment(sheetId, x => !x.cleared_at, 'cleared_at remis à NULL')
    assert.equal(p.cleared_source, null)
    assert.equal(p.sheet_seen_at, null)
  })
})
