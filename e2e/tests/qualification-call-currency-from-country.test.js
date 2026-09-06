const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie l'auto-sélection de la devise selon le pays de l'adresse :
// - country=CA → CAD
// - country=US → USD
// - Taper "US" puis "CA" dans le champ pays du Quote tab fait toggler la devise
//   en live (event 'input')
describe('Guide d\'appel — devise auto selon pays', () => {
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

  test('country=CA → CAD, country=US → USD (input live + sync vers .quote-curr.active)', async () => {
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

    // Slide 6 (Proposal) — quote tab par défaut
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })

    // Tape "US" dans le champ pays du form billing
    const countryEl = frame.locator('#quote-pay-addr-country')
    await countryEl.fill('US')
    await page.waitForTimeout(200)
    // USD doit être actif
    assert.equal(
      await frame.locator('.quote-curr[data-currency="USD"]').evaluate(el => el.classList.contains('active')),
      true,
      'USD actif après country=US'
    )
    // Unit price doit refléter USD
    assert.equal((await frame.locator('.quote-unit-price[data-target="helper"]').textContent()).trim(), '$130/mo')

    // Tape "CA" → CAD
    await countryEl.fill('CA')
    await page.waitForTimeout(200)
    assert.equal(
      await frame.locator('.quote-curr[data-currency="CAD"]').evaluate(el => el.classList.contains('active')),
      true,
      'CAD actif après country=CA'
    )
    assert.equal((await frame.locator('.quote-unit-price[data-target="helper"]').textContent()).trim(), '$180/mo')

    // Country lowercase "ca" doit aussi marcher (uppercase normalisé)
    await countryEl.fill('us')
    await page.waitForTimeout(200)
    assert.equal(
      await frame.locator('.quote-curr[data-currency="USD"]').evaluate(el => el.classList.contains('active')),
      true,
      'country lowercase "us" → USD'
    )

    // Country inconnu (FR) : ne change rien (reste USD)
    await countryEl.fill('FR')
    await page.waitForTimeout(200)
    assert.equal(
      await frame.locator('.quote-curr[data-currency="USD"]').evaluate(el => el.classList.contains('active')),
      true,
      'country=FR : devise inchangée (reste USD)'
    )
  })
})
