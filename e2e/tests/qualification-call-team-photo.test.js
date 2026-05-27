const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le remplacement de Jean-Martin par la photo Team / "Orisha Team" sur
// la slide-2 (Agenda / How we work). Plus de quote textuelle, juste la photo et
// la légende "Orisha Team".
describe('Guide d\'appel — photo Team / Orisha Team (slide-2)', () => {
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

  test('photo Team affichée, plus de quote Jean-Martin, légende "Orisha Team"', async () => {
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
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(2)
    })
    await slidePage.locator('#slide-2.visible').waitFor({ state: 'visible', timeout: 3000 })

    // Image src pointe vers /erp/p/... (token public-files Team.jpg)
    const imgSrc = await slidePage.locator('#slide-2 .testimonial-split-img').getAttribute('src')
    assert.equal(imgSrc, '/erp/p/6a79d74237df27f3d91cd1c3c70ffd90', 'Image src = token Team.jpg')

    // Légende "Orisha Team"
    const authorText = (await slidePage.locator('#slide-2 .testimonial-split-author').textContent()).trim()
    assert.equal(authorText, 'Orisha Team')

    // Plus de quote textuelle (testimonial-split-text absent)
    const quoteCount = await slidePage.locator('#slide-2 .testimonial-split-text').count()
    assert.equal(quoteCount, 0, 'Aucun testimonial-split-text sur slide-2')

    // Plus de "Jean-Martin" nulle part sur la slide
    const slideText = await slidePage.locator('#slide-2').textContent()
    assert.equal(slideText.includes('Jean-Martin'), false, 'Plus de mention "Jean-Martin"')

    await slidePage.close()
  })
})
