const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie qu'en vue client (popup slide view), slide-2 (Introduction) affiche
// désormais l'agenda (intro-roadmap) dans la colonne gauche 2/5 et le bloc
// Jean-Martin (image plein-droit + quote overlay) dans la colonne droite,
// reproduisant le pattern de slide-3 (How we help).
describe('Guide d\'appel — slide-2 montre l\'agenda + JM en vue client', () => {
  let browser, ctx, page, db
  let companyId, companyName
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const row = db.prepare(`
      SELECT id, name FROM companies
      WHERE name IS NOT NULL AND name != ''
      ORDER BY name LIMIT 1
    `).get()
    if (!row) throw new Error('Aucune company en DB')
    companyId = row.id
    companyName = row.name

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (createdCallId) {
      try {
        db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(createdCallId)
      } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('vue client : intro-roadmap et JM visibles dans la même slide (Step 1)', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.locator('button:has-text("Nouvel appel")').first().click()
    await page.fill('input[placeholder*="Rechercher une entreprise"]', companyName)
    await page.waitForTimeout(150)
    await page.locator(`button:has-text("${companyName}")`).first().click()

    const frame = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frame.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    const fresh = db.prepare(`
      SELECT id FROM qualification_calls
      WHERE company_id = ? AND airtable_record_id LIKE 'local_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId)
    if (fresh) createdCallId = fresh.id

    // Ouvre la popup slide view
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup'),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    // Attend l'init complète de la popup (slide-0 visible par défaut au chargement)
    await slidePage.locator('#slide-0.visible').waitFor({ state: 'visible', timeout: 5000 })

    // Navigue vers slide-2 (Step 1 client) via la sidebar (Introduction)
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(2)
    })
    await slidePage.locator('#slide-2.visible').waitFor({ state: 'visible', timeout: 3000 })

    // L'intro-roadmap doit être visible en vue client (auparavant hidden)
    const roadmapVisible = await slidePage.locator('#intro-roadmap').isVisible()
    assert.ok(roadmapVisible, 'intro-roadmap doit être visible en vue client')

    // Les 4 cartes d'agenda sont là
    const cards = await slidePage.locator('#intro-roadmap .intro-step').count()
    assert.equal(cards, 4, '4 cartes d\'agenda attendues')

    // L'agenda est dans slide-quote-content (colonne gauche 2/5)
    const roadmapInContent = await slidePage.locator('#slide-2 .slide-quote-content #intro-roadmap').count()
    assert.equal(roadmapInContent, 1, 'intro-roadmap doit être dans slide-quote-content (colonne gauche)')

    // L'image JM doit être en position:fixed (full-screen droite, comme slide-3)
    const imgPos = await slidePage.locator('#slide-2 .testimonial-split-img').evaluate(
      el => window.getComputedStyle(el).position
    )
    assert.equal(imgPos, 'fixed', 'L\'image JM doit être en position fixed (full-screen droite)')

    // Le bloc quote est .how-quote-card (overlay sur l'image)
    const quoteCardVisible = await slidePage.locator('#slide-2 .how-quote-card').isVisible()
    assert.ok(quoteCardVisible, 'Le how-quote-card (overlay quote JM) doit être visible')

    // L'auteur doit être Jean-Martin Fortier
    const author = await slidePage.locator('#slide-2 .how-quote-card .testimonial-split-author').textContent()
    assert.equal(author.trim(), 'Jean-Martin Fortier')

    // L'agenda ne doit pas chevaucher l'image JM (colonne gauche s'arrête avant)
    const contentBox = await slidePage.locator('#slide-2 .slide-quote-content').boundingBox()
    const imgBox = await slidePage.locator('#slide-2 .testimonial-split-img').boundingBox()
    assert.ok(contentBox && imgBox, 'Boîtes englobantes attendues')
    assert.ok(
      contentBox.x + contentBox.width <= imgBox.x,
      `La colonne agenda (right=${contentBox.x + contentBox.width}) ne doit pas déborder sous l'image (left=${imgBox.x})`
    )

    await slidePage.close()
  })
})
