const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que Transition proposal est maintenant une vraie slide (slide-8)
// dans la vue popup, avec la phrase "Would you like to see what Orisha looks
// like on your farm?" :
// - Naviguer à cur=8 affiche slide-8 et masque slide-5 (Demo)
// - Background image = vueserre.jpg via public-files
// - La phrase est présente et stylée comme transition-question
// - La slide n'est pas dans la sidebar du client (hidden:true)
// - Le footer affiche le nom sans numéro pour cette sous-étape
describe('Guide d\'appel — Transition proposal comme slide dédiée', () => {
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

  test('slide-8 affichée avec la phrase, absente du sidebar client', async () => {
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

    const [slidePage] = await Promise.all([
      page.waitForEvent('popup'),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#slide-0.visible').waitFor({ state: 'visible', timeout: 5000 })

    // Navigue à Demo (cur=5)
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(5)
    })
    await slidePage.locator('#slide-5.visible').waitFor({ state: 'visible', timeout: 3000 })

    // Navigue à Transition proposal (cur=8)
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(8)
    })
    await slidePage.locator('#slide-8.visible').waitFor({ state: 'visible', timeout: 3000 })

    // Demo n'est plus visible
    assert.equal(await slidePage.locator('#slide-5').evaluate(el => el.classList.contains('visible')), false, 'slide-5 (Demo) plus visible')

    // La phrase est présente
    const question = (await slidePage.locator('#slide-8 .transition-question').textContent()).trim()
    assert.equal(question, 'Would you like to see what Orisha looks like on your farm?')

    // Image vueserre via <img> positionnée absolument, opacity 0.5
    const imgSrc = await slidePage.locator('#slide-8 .transition-bg-img').getAttribute('src')
    assert.equal(imgSrc, '/erp/p/a4be902a1db8a70adaad9870fc0ec0d0', 'src = vueserre token')
    const imgOpacity = await slidePage.locator('#slide-8 .transition-bg-img').evaluate(el => window.getComputedStyle(el).opacity)
    assert.equal(imgOpacity, '0.75', 'opacity = 0.75')
    const titleColor = await slidePage.locator('#slide-8 .transition-question').evaluate(el => window.getComputedStyle(el).color)
    assert.equal(titleColor, 'rgb(255, 255, 255)', 'titre en blanc')
    const imgObjectFit = await slidePage.locator('#slide-8 .transition-bg-img').evaluate(el => window.getComputedStyle(el).objectFit)
    assert.equal(imgObjectFit, 'cover', 'object-fit:cover (image remplit le slide sans déformation)')
    const imgFilter = await slidePage.locator('#slide-8 .transition-bg-img').evaluate(el => window.getComputedStyle(el).filter)
    assert.ok(imgFilter.includes('blur'), 'filter:blur(...) appliqué')

    // Pas dans la sidebar client (hidden:true → exclu du nav client)
    const navTexts = await slidePage.locator('#nav .nav-item .nav-text').allTextContents()
    assert.equal(navTexts.includes('Transition proposal'), false, 'Transition proposal absente du sidebar client')

    // Footer step-info : nom sans numéro
    const stepInfo = (await slidePage.locator('#step-info').textContent()).trim()
    assert.equal(stepInfo, 'Transition proposal', 'Footer affiche "Transition proposal" sans numéro')

    await slidePage.close()
  })
})
