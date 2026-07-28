// Le FAB « Modifier le système » doit rester visible ET cliquable même quand
// une modale de l'app est ouverte — car la demande de modification peut
// concerner un élément situé DANS une modale. Régression : le FAB était en
// z-40, sous le fond des modales (z-50), donc masqué/non cliquable.
//
// Ce test ouvre la modale de détail d'un abonnement (page /abonnements) puis
// vérifie que le point central du FAB renvoie bien le FAB via elementFromPoint
// (donc rien ne le recouvre) — la seule vérif fiable de l'occlusion z-index.
// Aucune mutation de record (modale de détail lue puis fermée).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FeedbackFab — visible au-dessus des modales', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('le FAB reste au-dessus du fond d\'une modale ouverte', async () => {
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    const fab = page.locator('[data-testid="feedback-fab"]')

    // Sanity : le FAB est visible et topmost SANS modale.
    await fab.waitFor({ state: 'visible', timeout: 5000 })
    const topmostAtFab = async () => page.evaluate(() => {
      const btn = document.querySelector('[data-testid="feedback-fab"]')
      if (!btn) return 'none'
      const r = btn.getBoundingClientRect()
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      // true si l'élément au centre du FAB est le FAB ou l'un de ses enfants
      return btn.contains(el) ? 'fab' : (el ? el.tagName + '.' + (el.className || '') : 'null')
    })
    assert.equal(await topmostAtFab(), 'fab', 'le FAB doit être cliquable sans modale')

    // Ouvre la modale de détail d'un abonnement (clic sur la ligne, à droite du lien).
    const link = page.locator('a[href*="/companies/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const box = await link.boundingBox()
    assert.ok(box, 'lien company doit avoir une bounding box')
    await page.mouse.click(box.x + box.width + 200, box.y + box.height / 2)
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })

    // Cœur du test : malgré la modale (z-50), le FAB (z-9989) reste topmost.
    await fab.waitFor({ state: 'visible', timeout: 3000 })
    const result = await topmostAtFab()
    assert.equal(result, 'fab', `le FAB doit rester au-dessus de la modale, mais elementFromPoint = ${result}`)
  })
})
