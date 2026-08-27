// Comptabilité → bandeau du fichier « Maintien du solde disponible BNC » :
// la sync automatique tourne toutes les 60 minutes, et la cadence est ANNONCÉE
// à l'écran (sinon « synchronisé le … » ne dit pas si la donnée se rafraîchira
// dans 10 minutes ou demain).
//
// Lecture seule : aucun record créé, aucune configuration modifiée.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Comptabilité — cadence 60 min de la sync du fichier solde BNC', () => {
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

  test("l'API annonce une cadence de 60 min et la prochaine exécution", async () => {
    const r = await apiFetch('/treasury/solde-sheet/status')
    assert.equal(r.status, 200)
    assert.equal(r.body.every_minutes, 60, 'la sync doit être annoncée toutes les 60 min')
    // Prochaine exécution : l'heure pile suivante, donc dans moins de 60 min.
    const next = Date.parse(r.body.next_run_at)
    assert.ok(!Number.isNaN(next), 'next_run_at doit être une date ISO')
    const inMinutes = (next - Date.now()) / 60000
    assert.ok(inMinutes > 0 && inMinutes <= 60, `prochaine sync dans ${inMinutes} min`)
    assert.equal(new Date(next).getUTCMinutes(), 0, 'la sync est planifiée à l\'heure pile')
  })

  test('le bandeau /comptabilite affiche « sync auto toutes les 60 min »', async () => {
    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="treasury-section"]', { state: 'attached', timeout: 20000 })
    const bar = page.locator('[data-testid="treasury-sheet-sync"]')
    await bar.waitFor({ state: 'visible', timeout: 20000 })
    const cadence = page.locator('[data-testid="treasury-sheet-cadence"]')
    await cadence.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await cadence.textContent(), /toutes les 60\s*min/)
  })

  test('la dernière sync automatique remonte à moins de 60 min', async () => {
    const status = (await apiFetch('/treasury/solde-sheet/status')).body
    if (!status.active) return // automation désactivée : la cadence ne s'applique pas
    const run = status.last_run
    assert.ok(run, 'aucune sync journalisée')
    const ageMin = (Date.now() - Date.parse(run.executed_at)) / 60000
    // Tolérance : le cron tourne à l'heure pile, donc l'âge maximal attendu est
    // 60 min + le temps d'exécution de la sync elle-même.
    assert.ok(ageMin < 65, `dernière sync il y a ${Math.round(ageMin)} min`)
  })
})
