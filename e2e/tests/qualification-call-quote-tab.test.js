const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le nouvel onglet Quote dans la slide Proposal (vue assistant) :
// - Toggle USD/CAD met à jour les prix unitaires et le total
// - Compteurs +/- pour Helper et Chief Grower
// - Total = quantité × prix unitaire selon la devise
// - Total apparaît aussi en bas des 2 cartes dans la slide view (popup)
// - L'état persiste en DB sur quote_currency / quote_helper_count / quote_chief_count
describe('Guide d\'appel — onglet Quote (Proposal)', () => {
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

  test('toggle devise, compteurs +/-, total calculé, persistance DB, sync slide view', async () => {
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

    // Navigue vers la Proposal slide (sidebar position 4 — How we help=0, ongoing=1, demo=2, proposal=3 dans la liste visible)
    // Plus simple : on appelle goTo(6) directement
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.assistant-section-label:has-text("The proposal")').waitFor({ state: 'visible', timeout: 3000 })

    // Onglet Quote doit exister à côté de Script et Battle Cards
    const quoteTab = frame.locator('.step-tab[data-tab="quote"]')
    await quoteTab.waitFor({ state: 'visible', timeout: 3000 })
    assert.equal((await quoteTab.textContent()).trim(), 'Quote')

    // Click sur l'onglet Quote
    await quoteTab.click()
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })

    // État initial : USD active, 0 Helper, 0 Chief, total $0 USD/mo
    const usdBtn = frame.locator('.quote-curr[data-currency="USD"]')
    const cadBtn = frame.locator('.quote-curr[data-currency="CAD"]')
    assert.ok(await usdBtn.evaluate(el => el.classList.contains('active')), 'USD doit être actif par défaut')
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$0 USD/mo')

    // Click sur CAD
    await cadBtn.click()
    await page.waitForTimeout(100)
    assert.ok(await cadBtn.evaluate(el => el.classList.contains('active')), 'CAD doit devenir actif')
    // Prix unitaires doivent passer en CAD : Helper 180, Chief 290
    assert.equal((await frame.locator('.quote-unit-price[data-target="helper"]').textContent()).trim(), '$180/mo')
    assert.equal((await frame.locator('.quote-unit-price[data-target="chief"]').textContent()).trim(), '$290/mo')

    // +2 Helper, +1 Chief
    const helperPlus = frame.locator('.quote-step[data-action="inc"][data-target="helper"]')
    const chiefPlus = frame.locator('.quote-step[data-action="inc"][data-target="chief"]')
    await helperPlus.click()
    await helperPlus.click()
    await chiefPlus.click()
    await page.waitForTimeout(100)
    assert.equal((await frame.locator('.quote-count[data-target="helper"]').textContent()).trim(), '2')
    assert.equal((await frame.locator('.quote-count[data-target="chief"]').textContent()).trim(), '1')
    // Total = 2*180 + 1*290 = 650
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$650 CAD/mo')

    // Attend la persistance (debounce/PATCH du parent React)
    await page.waitForTimeout(1500)

    // Vérifie en DB
    const dbRow = db.prepare(`
      SELECT quote_currency, quote_helper_count, quote_chief_count
      FROM qualification_calls WHERE id = ?
    `).get(createdCallId)
    assert.equal(dbRow.quote_currency, 'CAD', 'Devise CAD persistée')
    assert.equal(dbRow.quote_helper_count, 2, 'Helper count persisté')
    assert.equal(dbRow.quote_chief_count, 1, 'Chief count persisté')

    // Ouvre la slide view popup et vérifie le total à la fin de slide-6
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup'),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    // Attend que la popup soit complètement initialisée (slide-0 visible par défaut)
    await slidePage.locator('#slide-0.visible').waitFor({ state: 'visible', timeout: 5000 })
    // Donne le temps au hello → reply (popup envoie hello 100ms après load)
    await slidePage.waitForTimeout(300)
    // Navigue vers slide-6
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await slidePage.locator('#slide-6.visible').waitFor({ state: 'visible', timeout: 3000 })
    // Donne le temps au handleSyncMessage de propager
    await slidePage.waitForTimeout(500)
    const slideTotal = await slidePage.locator('#proposal-total-amount').textContent()
    assert.equal(slideTotal.trim(), '$650 CAD/mo', 'Total affiché en bas de slide-6 doit matcher l\'assistant')

    // Décrément depuis l'assistant — popup doit suivre
    const helperMinus = frame.locator('.quote-step[data-action="dec"][data-target="helper"]')
    await helperMinus.click()
    await page.waitForTimeout(500)
    const slideTotal2 = await slidePage.locator('#proposal-total-amount').textContent()
    assert.equal(slideTotal2.trim(), '$470 CAD/mo', '1*180 + 1*290 = 470 CAD/mo après décrément')

    await slidePage.close()
  })
})
