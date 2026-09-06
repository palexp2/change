const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le stale-while-revalidate :
//   1. Cold start — localStorage vide, la 1ère visite peuple le cache
//   2. Warm start — les lignes s'affichent AVANT la réponse du fetch réseau
//      (preuve qu'elles viennent de localStorage)
describe('Interactions — stale-while-revalidate', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    // Partir d'un état propre : purger l'entrée SWR avant les mesures
    await page.evaluate(() => localStorage.removeItem('erp.swr:interactions'))
  })

  after(async () => { await browser?.close() })

  test('première visite peuple le cache; seconde visite affiche avant la réponse réseau', async () => {
    // ── 1) Cold start ─────────────────────────────────────────────────────
    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    // Attendre que la liste arrive et soit rendue
    await page.waitForResponse(
      r => /\/api\/interactions\?limit=all/.test(r.url()) && r.ok(),
      { timeout: 15000 }
    )
    await page.waitForSelector('.cursor-pointer.hover\\:bg-slate-50', { timeout: 10000 })

    const cachedLen = await page.evaluate(() => {
      const raw = localStorage.getItem('erp.swr:interactions')
      return raw ? JSON.parse(raw).data.length : 0
    })
    assert.ok(cachedLen > 0, `cache SWR peuplé après 1ère visite (${cachedLen} lignes)`)

    // ── 2) Warm start ─────────────────────────────────────────────────────
    // Partir d'une autre page puis revenir ; on mesure si les lignes
    // apparaissent AVANT la réponse /api/interactions
    await page.goto(`${URL}/dashboard`, { waitUntil: 'networkidle' })

    // Armer un watcher qui note l'ordre d'événements : rows-visible vs fetch-ok
    let rowsVisibleAt = null
    let fetchDoneAt = null
    const fetchPromise = page.waitForResponse(
      r => /\/api\/interactions\?limit=all/.test(r.url()) && r.ok(),
      { timeout: 15000 }
    ).then(() => { fetchDoneAt = Date.now() })
    const rowsPromise = page.waitForSelector('.cursor-pointer.hover\\:bg-slate-50', { timeout: 15000 })
      .then(() => { rowsVisibleAt = Date.now() })

    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    await Promise.all([fetchPromise, rowsPromise])

    assert.ok(rowsVisibleAt !== null && fetchDoneAt !== null, 'les deux événements ont eu lieu')
    // SWR : les lignes viennent du cache AVANT que la réponse réseau arrive.
    // On tolère 50ms de marge pour les races d'événements.
    assert.ok(
      rowsVisibleAt < fetchDoneAt + 50,
      `rows visibles à ${rowsVisibleAt} doit être avant (ou ~) la réponse à ${fetchDoneAt} (diff=${rowsVisibleAt - fetchDoneAt}ms)`
    )
  })
})
