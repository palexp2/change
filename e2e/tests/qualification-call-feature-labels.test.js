const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie les labels affichés sous les icônes d'automation dans la plan-card
// de la slide-6 (vue slide popup) :
// - Helper : Roll-ups
// - Chief : Roll-ups, Irrigation, Heating, End-wall Ventilation, Ridge Ventilation, Wind Protection
describe('Guide d\'appel — labels sous icônes automation', () => {
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

  test('labels Chief : Roll-ups, Irrigation, Heating, End-wall Ventilation, Ridge Ventilation, Wind Protection', async () => {
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
      if (typeof goTo === 'function') goTo(6)
    })
    await slidePage.locator('#slide-6.visible').waitFor({ state: 'visible', timeout: 3000 })

    // Plan-card par défaut sur Helper — switch vers Chief pour la liste complète
    await slidePage.locator('.plan-card .plan-tab[data-plan="chief"]').click()
    await slidePage.waitForTimeout(150)

    const labels = await slidePage.locator('#plan-automation .plan-automation-label').allTextContents()
    assert.deepEqual(
      labels.map(l => l.trim()),
      ['Roll-ups', 'Irrigation', 'Heating', 'End-wall Ventilation', 'Ridge Ventilation', 'Wind Protection'],
      'Labels Chief dans l\'ordre attendu'
    )

    // Switch vers Helper — seul Roll-ups
    await slidePage.locator('.plan-card .plan-tab[data-plan="helper"]').click()
    await slidePage.waitForTimeout(150)
    const helperLabels = await slidePage.locator('#plan-automation .plan-automation-label').allTextContents()
    assert.deepEqual(helperLabels.map(l => l.trim()), ['Roll-ups'], 'Helper a uniquement Roll-ups')

    await slidePage.close()
  })
})
