// Comptabilité → Projection BNC : lecture du Google Sheet « Maintien du solde
// disponible BNC » (le fichier tenu à la main).
//
// Désactivée le 2026-08-29 : elle créait des treasury_payments en double avec
// Pmt_Suivi et la cédule (même paiement importé deux fois, sous deux
// import_key différents) — voir memory reference_solde_sheet_sync et
// gotcha_solde_sheet_duplicates. Le 2026-09-12, le fichier a aussi disparu de
// la page (Charles : ses écarts n'appellent plus aucune décision). Ce fichier
// vérifie donc qu'elle RESTE inerte côté API, et que la projection continue de
// ne compter que des rentrées certaines.
//
// Lecture seule.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — sync du fichier Maintien du solde disponible BNC', () => {
  let browser, ctx, page

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
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('la sync manuelle refuse de tourner tant que l\'automation est désactivée', async () => {
    const r = await apiFetch('/treasury/solde-sheet/sync', {
      method: 'POST',
      body: JSON.stringify({ dry_run: true }),
    })
    assert.equal(r.status, 409, 'le bouton manuel ne doit pas être une porte de derrière pour la sync désactivée')
  })

  test('la projection ne compte que des rentrées certaines, et dit ce qu\'elle écarte', async () => {
    const r = await apiFetch('/treasury/projection')
    assert.equal(r.status, 200)
    const inflows = r.body.inflows
    assert.ok(inflows, 'la projection doit exposer le détail des rentrées')

    let sum = 0
    for (const p of inflows.counted) {
      // Chaque dollar compté est justifié : argent déjà chez Stripe et en route.
      assert.ok(p.certainty, 'une rentrée comptée doit dire pourquoi elle est sûre')
      assert.ok(['pending', 'in_transit', 'paid'].includes(p.status), `statut non certain compté : ${p.status}`)
      assert.ok(p.date >= new Date().toISOString().slice(0, 10), 'rentrée datée dans le passé')
      sum += p.amount
    }
    assert.ok(Math.abs(sum - inflows.total_counted) < 0.005)
    // Rien n'est écarté sans motif.
    for (const p of inflows.excluded) assert.ok(p.reason, 'rentrée écartée sans raison affichée')
    // Donnée Stripe périmée = aucune rentrée comptée (on ne mise pas sur un
    // statut qu'on n'a pas revérifié).
    if (inflows.stripe_stale) assert.equal(inflows.counted.length, 0)

    // Ce détail est visible sur la page, pas seulement dans l'API.
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { state: 'attached', timeout: 20000 })
    const banner = page.locator('[data-testid="treasury-inflows"]')
    if (inflows.counted.length || inflows.excluded.length) {
      await openAttention()
      await banner.waitFor({ state: 'visible', timeout: 15000 })
      // Libellés raccourcis (22 août 2026) : « Rentrées » est l'étiquette de la
      // ligne, la valeur ne répète plus le mot.
      const txt = await banner.textContent()
      if (inflows.counted.length) assert.match(txt, /Rentrées.*comptée/s)
      if (inflows.excluded.length) assert.match(txt, /non compté/)
    }
  })
})
