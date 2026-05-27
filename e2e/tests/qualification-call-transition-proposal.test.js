const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le contenu de la section "Transition proposal" (sous-étape index 8,
// alias de la slide-5) dans la vue assistant :
// - Gros titre "Transition proposal"
// - Subhead "Ask for proposal consent"
// - Script de demande de consentement
// - Note "Wait for a clear yes."
describe('Guide d\'appel — Transition proposal', () => {
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

  test('script "Ask for proposal consent" visible dans la transition proposal', async () => {
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

    // Navigue à la sous-étape Transition proposal (index 8 dans la séquence)
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(8)
    })
    await frame.locator('.assistant-section-label:has-text("Transition proposal")').waitFor({ state: 'visible', timeout: 3000 })

    const body = await frame.locator('#assistant-body').textContent()
    assert.ok(body.includes('Transition proposal'), 'Gros titre "Transition proposal" présent')
    assert.ok(body.includes('Ask for proposal consent'), 'Subhead "Ask for proposal consent" présent')
    assert.ok(!body.includes('Quick tip'), 'Pas de "Quick tip"')
    assert.ok(body.includes('"That covers the system. I think there\'s a real fit here for your farm. Do you want to look at what this would actually cost for your setup?"'), 'Script présent')
    assert.ok(body.includes('Wait for a clear yes.'), 'Note "Wait for a clear yes." présente')
  })
})
