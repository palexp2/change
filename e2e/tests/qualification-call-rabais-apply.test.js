const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le comportement de la colonne "Apply" dans l'onglet Rabais :
// - Cocher une ligne configure le discount du Quote tab en percent / forever
//   avec la valeur du partenaire
// - Mutuellement exclusive : cocher une 2e ligne décoche la 1ere
// - Re-cliquer sur une ligne cochée la décoche et désactive le discount
// - Modifier manuellement le discount dans le Quote tab efface la sélection Rabais
describe('Guide d\'appel — onglet Rabais, colonne Apply', () => {
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

  test('cocher Apply → configure le discount ; mutex ; re-clic décoche ; édition manuelle efface la sélection', async () => {
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

    // Slide 6, +2 Helper +1 Chief → 480/mo, lifetime 19200
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })
    const helperPlus = frame.locator('.quote-step[data-action="inc"][data-target="helper"]')
    const chiefPlus = frame.locator('.quote-step[data-action="inc"][data-target="chief"]')
    await helperPlus.click(); await helperPlus.click(); await chiefPlus.click()
    await page.waitForTimeout(150)

    // Va sur l'onglet Rabais
    await frame.locator('.step-tab[data-tab="rabais"]').click()
    await frame.locator('.rabais-table').waitFor({ state: 'visible', timeout: 3000 })

    // Toutes les checkboxes décochées au départ
    const allApplyChecked = async () => {
      const cbs = await frame.locator('.rabais-apply').all()
      const states = await Promise.all(cbs.map(c => c.isChecked()))
      return states
    }
    let states = await allApplyChecked()
    assert.equal(states.filter(s => s).length, 0, 'Aucune checkbox cochée au départ')

    // Coche Neversink (20%)
    await frame.locator('.rabais-row[data-rabais-partner="neversink-farm"] .rabais-apply').check()
    await page.waitForTimeout(200)

    // Retourne au Quote tab et vérifie : checkbox Apply discount on, % off, value 20, forever
    await frame.locator('.step-tab[data-tab="quote"]').click()
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })
    assert.equal(await frame.locator('#quote-pay-discount-on').isChecked(), true, 'Apply discount activé')
    assert.equal(await frame.locator('#quote-pay-discount-value').inputValue(), '20', 'Value = 20')
    assert.equal(
      await frame.locator('.quote-pay-seg[data-group="type"] button[data-type="percent"]').evaluate(el => el.classList.contains('active')),
      true,
      'Type = percent'
    )
    assert.equal(
      await frame.locator('.quote-pay-seg[data-group="duration"] button[data-duration="forever"]').evaluate(el => el.classList.contains('active')),
      true,
      'Duration = forever'
    )
    // Total monthly : 480 - 20% = 384
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$384 USD/mo')
    // Lifetime total : 19200 - 20% = 15360
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$15,360')

    // Retour Rabais : Neversink coché, autres non
    await frame.locator('.step-tab[data-tab="rabais"]').click()
    states = await allApplyChecked()
    assert.equal(states.filter(s => s).length, 1, 'Une seule checkbox cochée après application Neversink')
    assert.equal(
      await frame.locator('.rabais-row[data-rabais-partner="neversink-farm"] .rabais-apply').isChecked(),
      true,
      'Neversink coché'
    )

    // Coche Clay Bottom Farm (15%) → mutex : Neversink se décoche
    await frame.locator('.rabais-row[data-rabais-partner="clay-bottom-farm"] .rabais-apply').check()
    await page.waitForTimeout(200)
    assert.equal(
      await frame.locator('.rabais-row[data-rabais-partner="neversink-farm"] .rabais-apply').isChecked(),
      false,
      'Neversink décoché après check de Clay Bottom'
    )
    assert.equal(
      await frame.locator('.rabais-row[data-rabais-partner="clay-bottom-farm"] .rabais-apply').isChecked(),
      true,
      'Clay Bottom Farm coché'
    )
    // Total monthly : 480 - 15% = 408
    await frame.locator('.step-tab[data-tab="quote"]').click()
    assert.equal(await frame.locator('#quote-pay-discount-value').inputValue(), '15', 'Value = 15')
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$408 USD/mo')

    // Re-clic sur Clay Bottom → décoche, désactive le discount
    await frame.locator('.step-tab[data-tab="rabais"]').click()
    await frame.locator('.rabais-row[data-rabais-partner="clay-bottom-farm"] .rabais-apply').uncheck()
    await page.waitForTimeout(200)
    states = await allApplyChecked()
    assert.equal(states.filter(s => s).length, 0, 'Aucune checkbox cochée après uncheck')
    await frame.locator('.step-tab[data-tab="quote"]').click()
    assert.equal(await frame.locator('#quote-pay-discount-on').isChecked(), false, 'Apply discount désactivé après uncheck Rabais')
    assert.equal((await frame.locator('#quote-total-display').textContent()).trim(), '$480 USD/mo', 'Total revient à 480 plein')

    // Re-coche un rabais (CGN 10%) puis modifie manuellement le value dans Quote tab
    // → la sélection Rabais doit être effacée
    await frame.locator('.step-tab[data-tab="rabais"]').click()
    await frame.locator('.rabais-row[data-rabais-partner="cgn"] .rabais-apply').check()
    await page.waitForTimeout(200)
    assert.equal(
      await frame.locator('.rabais-row[data-rabais-partner="cgn"] .rabais-apply').isChecked(),
      true,
      'CGN coché'
    )

    await frame.locator('.step-tab[data-tab="quote"]').click()
    assert.equal(await frame.locator('#quote-pay-discount-value').inputValue(), '10')
    // Modifier la value manuellement → décoche le rabais
    await frame.locator('#quote-pay-discount-value').fill('25')
    await page.waitForTimeout(200)
    await frame.locator('.step-tab[data-tab="rabais"]').click()
    await page.waitForTimeout(150)
    states = await allApplyChecked()
    assert.equal(states.filter(s => s).length, 0, 'Aucune checkbox cochée après édition manuelle du value')
  })
})
