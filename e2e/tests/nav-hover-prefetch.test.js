const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le hover-prefetch sur la sidebar :
//   - un hover de ≥120ms sur un lien déclenche la requête de la page cible
//   - le clic qui suit ne redéclenche pas le même appel (cache de promise
//     dans prefetch.js réutilisé par api.js)
describe('Sidebar — hover-prefetch', () => {
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
    // Assurer qu'on part d'une page qui n'interroge PAS /interactions
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
  })

  after(async () => { await browser?.close() })

  test('hover + click ne déclenche qu\'une seule requête liste', async () => {
    // Compter toutes les requêtes vers /api/interactions?limit=all...
    const hits = []
    const onReq = (req) => {
      if (/\/api\/interactions\?limit=all/.test(req.url())) hits.push(req.url())
    }
    page.on('request', onReq)

    // Ouvrir le groupe "Clients" qui contient Interactions (il peut être
    // replié si on n'est pas déjà sur une page du groupe).
    const clientsGroup = page.locator('button:has-text("Clients")').first()
    if (await clientsGroup.isVisible().catch(() => false)) {
      const expanded = await clientsGroup.getAttribute('aria-expanded')
      if (expanded === 'false') await clientsGroup.click()
    }

    // 1) Hover sur le lien Interactions, assez longtemps pour franchir les 120ms
    const link = page.locator('a[href$="/interactions"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    await link.hover()

    // 2) Attendre que la requête de prefetch parte et revienne
    await page.waitForResponse(
      r => /\/api\/interactions\?limit=all/.test(r.url()) && r.ok(),
      { timeout: 10000 }
    )
    assert.equal(hits.length, 1, `prefetch devait déclencher 1 requête, obtenu ${hits.length}`)

    // 3) Cliquer pour naviguer — le cache doit servir sans refaire le réseau
    await link.click()
    await page.waitForURL(u => u.toString().endsWith('/interactions'), { timeout: 5000 })
    // Laisser le temps à un éventuel second fetch de partir (il ne devrait pas)
    await page.waitForTimeout(500)

    page.off('request', onReq)
    assert.equal(hits.length, 1, `après navigation, le cache devait servir — vu ${hits.length} requêtes`)
  })
})
