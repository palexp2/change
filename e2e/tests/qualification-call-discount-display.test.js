const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie l'affichage du rabais sur le montant mensuel dans la vue assistant
// (Quote tab du step Proposal) ET dans la vue slide (slide-6 popup) :
// - Sans discount : pas de strikethrough, pas de summary
// - 10% off forever : strikethrough = original, total = original * 0.9, summary = "10% off · forever"
// - $50 off first 3 months : strikethrough, total = original - 50, summary inclut "first 3 months"
// - Décocher : repasse à l'affichage non-discounted
describe('Guide d\'appel — affichage du rabais (vue assistant + slide)', () => {
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

  test('rabais affiché en vue assistant et propagé à la vue slide', async () => {
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

    // Slide 6 (Proposal)
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })

    // USD par défaut. Ajoute 2 Helpers + 1 Chief : 2*130 + 1*220 = $480 USD/mo
    const helperPlus = frame.locator('.quote-step[data-action="inc"][data-target="helper"]')
    const chiefPlus = frame.locator('.quote-step[data-action="inc"][data-target="chief"]')
    await helperPlus.click()
    await helperPlus.click()
    await chiefPlus.click()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$480 USD/mo')
    // Sans discount → pas de strikethrough, pas de summary
    assert.equal(await frame.locator('#quote-total-original').isVisible(), false, 'No strikethrough without discount')
    assert.equal(await frame.locator('#quote-discount-summary').isVisible(), false, 'No summary without discount')

    // Coche Apply discount (défaut : percent / forever — les rabais partenaires
    // s'appliquent pour toute la durée de l'abonnement)
    const discountCheckbox = frame.locator('#quote-pay-discount-on')
    await discountCheckbox.check()
    await page.waitForTimeout(150)
    // Saisit 10% (percent, forever par défaut)
    await frame.locator('#quote-pay-discount-value').fill('10')
    await page.waitForTimeout(200)
    // Total = 480 * 0.9 = 432, original = 480
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$432 USD/mo')
    assert.equal((await frame.locator('#quote-total-original').textContent()).trim(), '$480 USD/mo')
    // En 'forever', pas de summary — le strikethrough seul suffit
    assert.equal(await frame.locator('#quote-discount-summary').isVisible(), false, 'No summary for forever duration')

    // Change duration → once (first month) — summary doit apparaître
    await frame.locator('.quote-pay-seg[data-group="duration"] button[data-duration="once"]').click()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('#quote-discount-summary').textContent()).trim(), '10% off · first month')

    // Re-passe à forever pour la suite du test — summary doit disparaître à nouveau
    await frame.locator('.quote-pay-seg[data-group="duration"] button[data-duration="forever"]').click()
    await page.waitForTimeout(150)
    assert.equal(await frame.locator('#quote-discount-summary').isVisible(), false, 'No summary after switching back to forever')

    // Switch type → amount, value 50 → 480 - 50 = 430
    await frame.locator('.quote-pay-seg[data-group="type"] button[data-type="amount"]').click()
    await page.waitForTimeout(150)
    await frame.locator('#quote-pay-discount-value').fill('50')
    await page.waitForTimeout(200)
    // duration toujours forever → pas de summary
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$430 USD/mo')
    assert.equal(await frame.locator('#quote-discount-summary').isVisible(), false, 'No summary for $ amount in forever')

    // duration repeating, 3 mois — summary apparaît avec la durée
    await frame.locator('.quote-pay-seg[data-group="duration"] button[data-duration="repeating"]').click()
    await page.waitForTimeout(150)
    // months input default = 3
    assert.equal((await frame.locator('#quote-discount-summary').textContent()).trim(), '$50 off · first 3 months')

    // === Vue slide popup ===
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup'),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#slide-0.visible').waitFor({ state: 'visible', timeout: 5000 })
    await slidePage.waitForTimeout(400) // hello → reply propagation
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await slidePage.locator('#slide-6.visible').waitFor({ state: 'visible', timeout: 3000 })
    await slidePage.waitForTimeout(400) // handleSyncMessage propagation

    // La popup doit voir le total discounté ET le strikethrough ET le summary
    assert.equal((await slidePage.locator('#proposal-total-amount').textContent()).trim(), '$430 USD/mo')
    assert.equal(await slidePage.locator('#proposal-total-original').isVisible(), true, 'Strikethrough visible in slide view')
    assert.equal((await slidePage.locator('#proposal-total-original').textContent()).trim(), '$480 USD/mo')
    assert.equal((await slidePage.locator('#proposal-discount-summary').textContent()).trim(), '$50 off · first 3 months')

    // Décoche depuis l'assistant — la popup doit revenir au total plein
    await discountCheckbox.uncheck()
    await page.waitForTimeout(500)
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$480 USD/mo')
    assert.equal(await frame.locator('#quote-total-original').isVisible(), false, 'Strikethrough hidden after uncheck')
    assert.equal(await frame.locator('#quote-discount-summary').isVisible(), false, 'Summary hidden after uncheck')
    assert.equal((await slidePage.locator('#proposal-total-amount').textContent()).trim(), '$480 USD/mo')
    assert.equal(await slidePage.locator('#proposal-total-original').isVisible(), false, 'Slide strikethrough hidden after uncheck')
    assert.equal(await slidePage.locator('#proposal-discount-summary').isVisible(), false, 'Slide summary hidden after uncheck')

    // Régression : quand qty=0 (donc original=$0), un rabais coché ne doit pas
    // afficher de strikethrough "$0" au-dessus du "$0" courant.
    const helperMinus = frame.locator('.quote-step[data-action="dec"][data-target="helper"]')
    const chiefMinus = frame.locator('.quote-step[data-action="dec"][data-target="chief"]')
    await helperMinus.click(); await helperMinus.click()
    await chiefMinus.click()
    await page.waitForTimeout(200)
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$0 USD/mo')
    // Recoche un rabais 10% — total reste à $0 mais pas de strikethrough
    await discountCheckbox.check()
    await page.waitForTimeout(150)
    await frame.locator('#quote-pay-discount-value').fill('10')
    await page.waitForTimeout(200)
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$0 USD/mo')
    assert.equal(await frame.locator('#quote-total-original').isVisible(), false, 'No strikethrough monthly quand original=$0')
    await slidePage.waitForTimeout(300)
    assert.equal(await slidePage.locator('#proposal-total-original').isVisible(), false, 'No strikethrough slide quand original=$0')

    await slidePage.close()
  })
})
