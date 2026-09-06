const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const VENDOR = `E2E Desabo ${Date.now()}`
// Page « d'annulation » du fournisseur, factice : le test vérifie seulement
// que le bouton ouvre bien un onglet dessus.
const CANCEL_URL = 'https://example.com/e2e-cancel'

// L'URL d'un onglet ouvert par window.open n'est pas toujours committée
// immédiatement — on la sonde brièvement.
async function popupUrl(tab) {
  for (let i = 0; i < 25; i++) {
    const u = tab.url()
    if (u && u !== 'about:blank') return u
    await tab.waitForTimeout(200)
  }
  return tab.url()
}

describe('Abonnements fournisseurs — bouton « Se désabonner »', () => {
  let browser, ctx, page, createdId, knownId

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Record jetable — jamais toucher un vrai abonnement. billing_day = 1 pour
    // que la charge attendue soit passée : l'abonnement remonte alors dans le
    // bandeau des charges non comptabilisées (aucun reçu, aucun achat QB).
    const created = await apiFetch('/vendor-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ vendor: VENDOR, plan: 'E2E', amount: 1, frequency: 'Mensuel', billing_day: 1 }),
    })
    assert.equal(created.status, 201, 'création de l\'abonnement jetable')
    createdId = created.body.id
  })

  after(async () => {
    try {
      if (createdId) await apiFetch(`/vendor-subscriptions/${createdId}`, { method: 'DELETE' })
      if (knownId) await apiFetch(`/vendor-subscriptions/${knownId}`, { method: 'DELETE' })
    } catch {}
    await browser?.close()
  })

  test('le bouton de la liste est visible sans défilement horizontal', async () => {
    // Reproduit le cas réel : le navigateur a mémorisé la liste de colonnes
    // AVANT l'ajout de la colonne Action — elle doit quand même s'afficher.
    await page.goto(URL + '/abonnements-fournisseurs', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => localStorage.setItem('erp_allView_cols_vendor_subscriptions',
      JSON.stringify(['vendor', 'plan', 'currency', 'variable', 'amount', 'taxes',
        'frequency', 'billing_label', 'payment_method', 'active'])))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Abonnements fournisseurs")', { timeout: 60000 })
    const btn = page.locator(`[data-testid="unsub-${createdId}"]`)
    await btn.waitFor({ state: 'attached', timeout: 60000 })
    const box = await btn.boundingBox()
    const vw = await page.evaluate(() => window.innerWidth)
    assert.ok(box, 'bouton sans boîte englobante')
    assert.ok(box.x >= 0 && box.x + box.width <= vw,
      `bouton hors écran (x=${box.x}, w=${box.width}, viewport=${vw}) — il faut défiler pour le voir`)
  })

  test('un clic sur le bouton désabonne, le toast permet d\'annuler', async () => {
    const btn = page.locator(`[data-testid="unsub-${createdId}"]`)
    await btn.waitFor({ state: 'visible', timeout: 60000 })
    assert.equal((await btn.innerText()).trim(), 'Se désabonner')

    // Le clic OUVRE la page tout seul (ici une recherche : ce fournisseur
    // jetable n'est dans aucun répertoire) et n'annule rien encore.
    const [searchTab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      btn.click(),
    ])
    assert.match(await popupUrl(searchTab), /google\.com\/search/, 'recherche ouverte automatiquement')
    await searchTab.close()
    await page.waitForSelector('[data-testid="unsub-confirm"]', { timeout: 15000 })
    let row = await apiFetch(`/vendor-subscriptions/${createdId}`)
    assert.equal(row.body.active, 1, 'le clic seul ne doit pas désabonner')

    // Correction du lien : mémorisé pour les fois suivantes.
    await page.fill('[data-testid="unsub-url"]', CANCEL_URL)
    const [tab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      page.click('[data-testid="unsub-open-page"]'),
    ])
    assert.equal((await popupUrl(tab)).replace(/\/$/, ''), CANCEL_URL, 'onglet ouvert sur la page du fournisseur')
    await tab.close()
    await page.click('[data-testid="unsub-confirm"]')

    // La ligne bascule sur « Réactiver » et le serveur a bien enregistré l'annulation.
    await page.waitForSelector(`[data-testid="resub-${createdId}"]`, { timeout: 15000 })
    row = await apiFetch(`/vendor-subscriptions/${createdId}`)
    assert.equal(row.body.active, 0, 'abonnement marqué annulé côté serveur')
    assert.ok(row.body.cancelled_at, 'date de désabonnement horodatée')
    assert.equal(row.body.cancel_url, CANCEL_URL, 'lien d\'annulation mémorisé')

    // Toast d'annulation en un clic.
    const undo = page.locator('button:has-text("Annuler")').last()
    await undo.waitFor({ state: 'visible', timeout: 5000 })
    await undo.click()

    await page.waitForSelector(`[data-testid="unsub-${createdId}"]`, { timeout: 15000 })
    await page.waitForFunction(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/vendor-subscriptions/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const b = await r.json()
      return b.active === 1 && !b.cancelled_at
    }, createdId, { timeout: 15000 })
  })

  test('le bouton est aussi dans la fiche de l\'abonnement', async () => {
    // Cibler la ligne du tableau : le nom apparaît aussi dans le bandeau.
    await page.click(`[data-row-id="${createdId}"] >> text=${VENDOR}`)
    await page.waitForSelector('[data-testid="sub-plan"]', { timeout: 15000 })
    const modalBtn = page.locator(`[role="dialog"] [data-testid="unsub-${createdId}"]`)
    await modalBtn.waitFor({ state: 'visible', timeout: 10000 })
    // Lien connu → la page du fournisseur s'ouvre toute seule.
    const [tab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      modalBtn.click(),
    ])
    assert.equal((await popupUrl(tab)).replace(/\/$/, ''), CANCEL_URL)
    await tab.close()
    await page.click('[data-testid="unsub-confirm"]')
    await page.waitForSelector(`[data-testid="resub-${createdId}"]`, { timeout: 15000 })
    const row = await apiFetch(`/vendor-subscriptions/${createdId}`)
    assert.equal(row.body.active, 0, 'désabonnement depuis la fiche')
    // Remis actif pour le test du bandeau (qui ne liste que les actifs).
    await apiFetch(`/vendor-subscriptions/${createdId}`, { method: 'PUT', body: JSON.stringify({ active: 1 }) })
  })

  test('un fournisseur connu reçoit sa page d\'annulation automatiquement', async () => {
    const created = await apiFetch('/vendor-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ vendor: `Airtable E2E ${Date.now()}`, frequency: 'Mensuel' }),
    })
    assert.equal(created.status, 201)
    knownId = created.body.id
    assert.equal(created.body.cancel_url, 'https://airtable.com/account/billing',
      'page d\'annulation résolue depuis le répertoire, sans saisie')
  })

  test('le bandeau des charges non comptabilisées porte le même bouton', async () => {
    // Le croisement serveur distingue « Aucune trace » (ni reçu ni achat QB)
    // de « Reçu non comptabilisé ».
    const report = await apiFetch('/vendor-subscriptions/missing-receipts')
    const mine = report.body.missing.filter(m => m.subscription_id === createdId)
    assert.ok(mine.length, 'la charge attendue devrait être signalée')
    assert.equal(mine[0].status, 'missing')
    assert.ok('to_book' in report.body.counts, 'compteurs par statut exposés')

    await page.goto(URL + '/abonnements-fournisseurs', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="missing-receipts"]', { timeout: 60000 })
    const bannerBtn = page.locator(`[data-testid="missing-receipts"] [data-testid="mr-unsub-${createdId}"]`)
    await bannerBtn.waitFor({ state: 'visible', timeout: 60000 })
    const [tab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      bannerBtn.click(),
    ])
    await tab.close()
    await page.click('[data-testid="unsub-confirm"]')

    // La ligne quitte le bandeau et l'abonnement est annulé côté serveur.
    await page.waitForSelector(`[data-testid="mr-unsub-${createdId}"]`, { state: 'detached', timeout: 20000 })
    const row = await apiFetch(`/vendor-subscriptions/${createdId}`)
    assert.equal(row.body.active, 0, 'désabonnement depuis le bandeau')
  })
})
