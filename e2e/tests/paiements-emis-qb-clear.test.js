// /paiements-emis — détection du « passé à la banque » via QuickBooks.
//
// Le grand livre QuickBooks marque chaque écriture compensée (appariée au flux
// bancaire) ou rapprochée : c'est la preuve que l'argent est sorti du compte.
// Vérifie :
//   1. le panneau et son bouton « Synchroniser avec QuickBooks » sont là ;
//   2. la synchronisation réelle répond et l'affichage correspond exactement à
//      ce que le serveur a détecté (nombre de candidats à confirmer) ;
//   3. GARDE-FOU : confirmer un paiement que QuickBooks ne connaît pas ne coche
//      RIEN (le serveur re-détecte, il ne fait pas confiance à l'id reçu) ;
//   4. un paiement coché par QuickBooks l'annonce dans l'infobulle du pill.
//
// Aucun record réel n'est touché : les paiements créés portent un libellé
// jetable marqué E2E sur un compte hors projection (« E2E Compte »), invisible
// de la détection (qui ne lit que le compte projeté), et sont supprimés dans
// after(). Le clic sur « Synchroniser » exécute la même action que l'automation
// horaire sys_treasury_qb_clear — il ne crée rien et reste réversible (le pill
// se décoche).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const PENDING_LABEL = `E2E QB pending ${STAMP}`
const QB_CLEARED_LABEL = `E2E QB cleared ${STAMP}`

describe('Paiements émis — détection QuickBooks du passé à la banque', () => {
  let browser, ctx, page
  const createdIds = []
  let pendingId, qbClearedId

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  const getPayment = async (id) => {
    const r = await apiFetch('/treasury/payments?status=all&limit=500')
    assert.equal(r.status, 200)
    const p = (r.body || []).find(x => x.id === id)
    assert.ok(p, `Paiement ${id} absent de la liste`)
    return p
  }

  const createPayment = async (body) => {
    const r = await apiFetch('/treasury/payments', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(r.status, 201)
    createdIds.push(r.body.id)
    return r.body.id
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

    pendingId = await createPayment({
      payment_date: '2026-08-05', direction: 'out', amount: 7.77,
      account: 'E2E Compte', label: PENDING_LABEL, method: 'autre',
    })
    qbClearedId = await createPayment({
      payment_date: '2026-08-05', direction: 'out', amount: 8.88,
      account: 'E2E Compte', label: QB_CLEARED_LABEL, method: 'autre',
      cleared_at: new Date().toISOString(), cleared_source: 'qb',
    })
  })

  after(async () => {
    for (const id of createdIds) {
      await apiFetch(`/treasury/payments/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    await browser?.close()
  })

  test('le panneau QuickBooks et son bouton de synchronisation sont présents', async () => {
    await page.goto(URL + '/paiements-emis', { waitUntil: 'domcontentloaded' })
    const panel = page.locator('[data-testid="qb-clear-panel"]')
    await panel.waitFor({ timeout: 15000 })
    // Rien à confirmer = une ligne discrète ; sinon l'encadré des arbitrages.
    assert.match(await panel.textContent(), /QuickBooks/)
    await page.waitForSelector('[data-testid="qb-clear-sync"]')
  })

  test('confirmer un paiement inconnu de QuickBooks ne coche rien', async () => {
    // Le serveur re-détecte avant d'appliquer : un id envoyé par le client ne
    // suffit jamais à cocher « passé à la banque ».
    const r = await apiFetch('/treasury/payments/qb-clear/apply', {
      method: 'POST', body: JSON.stringify({ payment_ids: [pendingId] }),
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.applied, [])
    assert.equal(r.body.skipped, 1)
    const p = await getPayment(pendingId)
    assert.equal(p.cleared_at, null, 'le paiement doit rester en attente')
  })

  test('la synchronisation affiche exactement ce que le serveur a détecté', async () => {
    // La lecture du grand livre QuickBooks prend quelques secondes : on attend
    // la réponse réelle, sinon on comparerait l'affichage d'avant le clic.
    const [resp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/treasury/payments/qb-clear') && r.request().method() === 'POST', { timeout: 60000 }),
      page.click('[data-testid="qb-clear-sync"]'),
    ])
    assert.equal(resp.status(), 200)
    await page.waitForSelector('[data-testid="qb-clear-count"], [data-testid="qb-clear-empty"]', { timeout: 15000 })
    const status = await apiFetch('/treasury/payments/qb-clear/status')
    assert.equal(status.status, 200)
    assert.equal(status.body.last_run?.status, 'success')
    const expected = (status.body.candidates || []).length
    const shown = await page.locator('[data-testid^="qb-candidate-"]').count()
    assert.equal(shown, expected, `panneau : ${shown} candidat(s) affiché(s) pour ${expected} détecté(s)`)
    if (!expected) await page.waitForSelector('[data-testid="qb-clear-empty"]')
    // Le paiement jetable est sur un compte hors projection : jamais proposé.
    assert.ok(!(status.body.candidates || []).some(c => c.payment_id === pendingId))
  })

  test('un paiement coché par QuickBooks l\'annonce dans son infobulle', async () => {
    await page.click('[data-testid="payments-tab-cleared"]')
    await page.waitForSelector(`[data-testid="payment-cleared-${qbClearedId}"]`, { timeout: 15000 })
    // Lecture atomique : la liste se re-rend (rechargements après sync), un
    // locator lu en deux temps peut se détacher entre les deux appels.
    const info = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="payment-cleared-${id}"]`)
      return el ? { text: el.textContent.trim(), title: el.getAttribute('title') } : null
    }, qbClearedId)
    assert.ok(info, 'pill du paiement introuvable')
    assert.equal(info.text, 'A passé')
    assert.match(info.title, /détecté dans QuickBooks \(écriture compensée au compte bancaire\)/)
  })
})
