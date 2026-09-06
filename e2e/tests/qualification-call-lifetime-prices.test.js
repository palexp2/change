const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie la section "Lifetime buyout — for reference only" dans la vue assistant
// (Quote tab du step Proposal) :
// - Unit prices : Helper $5,200/7,200 — Chief $8,800/11,600 selon USD/CAD
// - Subtotaux dynamiques selon les quantités (× N)
// - Total = somme des subtotaux, avec rabais appliqué (% ou $) sur le total
// - Strikethrough du total original quand rabais actif
// - Pas de bouton / interaction
// - N'apparaît PAS dans la vue slide (popup slide-6)
describe('Guide d\'appel — Lifetime buyout (Quote tab)', () => {
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

  test('section lifetime dynamique : qty × unit, rabais sur total, switch devise', async () => {
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

    // Slide 6 (Proposal), quote tab par défaut
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })

    // Section lifetime visible
    const lifetime = frame.locator('#quote-lifetime')
    await lifetime.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok((await lifetime.textContent()).toLowerCase().includes('lifetime'), 'Titre contient "lifetime"')
    assert.ok((await lifetime.textContent()).toLowerCase().includes('reference'), 'Titre contient "reference"')

    // État initial : qty=0, subtotaux $0, total $0, unit USD
    assert.equal((await frame.locator('.quote-lifetime-mult[data-target="helper"]').textContent()).trim(), '× 0')
    assert.equal((await frame.locator('.quote-lifetime-mult[data-target="chief"]').textContent()).trim(), '× 0')
    assert.equal((await frame.locator('.quote-lifetime-unit[data-target="helper"]').textContent()).trim(), '$5,200 ea')
    assert.equal((await frame.locator('.quote-lifetime-unit[data-target="chief"]').textContent()).trim(), '$8,800 ea')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="helper"]').textContent()).trim(), '$0')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="chief"]').textContent()).trim(), '$0')
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$0')
    assert.equal(await frame.locator('#quote-lifetime-total-original').isVisible(), false, 'No strikethrough without discount')

    // +2 Helper, +1 Chief : subtotaux = 2×5200=10400, 1×8800=8800 ; total = 19200
    const helperPlus = frame.locator('.quote-step[data-action="inc"][data-target="helper"]')
    const chiefPlus = frame.locator('.quote-step[data-action="inc"][data-target="chief"]')
    await helperPlus.click()
    await helperPlus.click()
    await chiefPlus.click()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('.quote-lifetime-mult[data-target="helper"]').textContent()).trim(), '× 2')
    assert.equal((await frame.locator('.quote-lifetime-mult[data-target="chief"]').textContent()).trim(), '× 1')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="helper"]').textContent()).trim(), '$10,400')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="chief"]').textContent()).trim(), '$8,800')
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$19,200')

    // Toggle CAD : unit + subtotaux + total switchent en CAD
    // 2×7200=14400, 1×11600=11600, total=26000
    await frame.locator('.quote-curr[data-currency="CAD"]').click()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('.quote-lifetime-unit[data-target="helper"]').textContent()).trim(), '$7,200 ea')
    assert.equal((await frame.locator('.quote-lifetime-unit[data-target="chief"]').textContent()).trim(), '$11,600 ea')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="helper"]').textContent()).trim(), '$14,400')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="chief"]').textContent()).trim(), '$11,600')
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$26,000')

    // Retour USD pour la suite
    await frame.locator('.quote-curr[data-currency="USD"]').click()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$19,200')

    // Applique rabais 10% percent (forever par défaut)
    await frame.locator('#quote-pay-discount-on').check()
    await page.waitForTimeout(150)
    await frame.locator('#quote-pay-discount-value').fill('10')
    await page.waitForTimeout(200)
    // Total avec rabais : 19200 * 0.9 = 17280, original strikethrough = 19200
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$17,280')
    assert.equal(await frame.locator('#quote-lifetime-total-original').isVisible(), true, 'Strikethrough visible avec rabais')
    assert.equal((await frame.locator('#quote-lifetime-total-original').textContent()).trim(), '$19,200')
    // Subtotaux ligne par ligne RESTENT au prix plein (rabais appliqué seulement au total)
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="helper"]').textContent()).trim(), '$10,400')
    assert.equal((await frame.locator('.quote-lifetime-price[data-target="chief"]').textContent()).trim(), '$8,800')

    // Switch rabais en montant $1000
    await frame.locator('.quote-pay-seg[data-group="type"] button[data-type="amount"]').click()
    await page.waitForTimeout(150)
    await frame.locator('#quote-pay-discount-value').fill('1000')
    await page.waitForTimeout(200)
    // Total avec $1000 off : 19200 - 1000 = 18200
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$18,200')
    assert.equal((await frame.locator('#quote-lifetime-total-original').textContent()).trim(), '$19,200')

    // Décoche rabais → strikethrough disparaît, total revient à 19200
    await frame.locator('#quote-pay-discount-on').uncheck()
    await page.waitForTimeout(150)
    assert.equal((await frame.locator('#quote-lifetime-total-amount').textContent()).trim(), '$19,200')
    assert.equal(await frame.locator('#quote-lifetime-total-original').isVisible(), false, 'Strikethrough disparaît sans rabais')

    // Pas de bouton dans la section lifetime
    const buttonCount = await lifetime.locator('button').count()
    assert.equal(buttonCount, 0, 'Aucun bouton dans la section lifetime — purement info')

    // Vérifie absence dans la vue slide popup
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
    assert.equal(await slidePage.locator('#quote-lifetime').count(), 0, 'Lifetime ne doit pas apparaître dans la vue slide')

    await slidePage.close()
  })
})
