const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie qu'on ne peut cocher que 2 "biggest challenge" (pain points) maximum
// dans la slide Discovery du guide d'appel de qualification.
// Pattern : on ouvre la popup slide view, navigue à slide-1, coche 2 items,
// tente d'en cocher un 3e (doit être ignoré), puis vérifie en DB qu'on n'a
// bien que 2 pains persistés.
describe('Qualification call — biggest challenge max 2', () => {
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

  test('cocher un 3e pain ne fait rien — limite à 2', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    await page.waitForSelector('h1:has-text("Appels de qualification")', { timeout: 8000 })
    const newCallBtn = page.locator('button:has-text("Nouvel appel")').first()
    await newCallBtn.click()
    await page.waitForSelector('input[placeholder*="Rechercher une entreprise"]', { timeout: 5000 })
    await page.fill('input[placeholder*="Rechercher une entreprise"]', companyName)
    await page.waitForTimeout(150)
    const item = page.locator(`button:has-text("${companyName}")`).first()
    await item.waitFor({ state: 'visible', timeout: 5000 })
    await item.click()

    const frameLoc = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frameLoc.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    const fresh = db.prepare(`
      SELECT id FROM qualification_calls
      WHERE company_id = ? AND airtable_record_id LIKE 'local_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId)
    if (fresh) createdCallId = fresh.id

    // Ouvre la slide view (popup)
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      frameLoc.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#qa-farm').waitFor({ state: 'visible', timeout: 5000 })

    // Navigue à slide-1 (Discovery) — hidden dans la nav, appel direct
    await slidePage.evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(1)
    })
    await slidePage.locator('#discovery-list').waitFor({ state: 'visible', timeout: 3000 })

    // Coche le 1er pain
    await slidePage.locator('[data-pain="crop_yields"]').click()
    await slidePage.waitForTimeout(200)
    assert.ok(
      await slidePage.locator('[data-pain="crop_yields"]').evaluate(el => el.classList.contains('checked')),
      '1er pain doit être checked'
    )

    // Coche le 2e pain
    await slidePage.locator('[data-pain="tied_to_farm"]').click()
    await slidePage.waitForTimeout(200)
    assert.ok(
      await slidePage.locator('[data-pain="tied_to_farm"]').evaluate(el => el.classList.contains('checked')),
      '2e pain doit être checked'
    )

    // Tente le 3e — doit rester non-checked
    await slidePage.locator('[data-pain="hiring"]').click()
    await slidePage.waitForTimeout(200)
    const thirdChecked = await slidePage.locator('[data-pain="hiring"]').evaluate(el => el.classList.contains('checked'))
    assert.equal(thirdChecked, false, '3e pain ne doit PAS être checked (limite à 2)')

    // Au total : exactement 2 cochés dans le DOM
    const totalChecked = await slidePage.locator('#discovery-list li.checked').count()
    assert.equal(totalChecked, 2, 'Exactement 2 pains cochés au total')

    // Désélectionne le 1er et vérifie qu'on peut maintenant cocher le 3e
    // (la limite est sur l'ajout, pas un blocage permanent)
    await slidePage.locator('[data-pain="crop_yields"]').click()
    await slidePage.waitForTimeout(200)
    await slidePage.locator('[data-pain="hiring"]').click()
    await slidePage.waitForTimeout(200)
    assert.ok(
      await slidePage.locator('[data-pain="hiring"]').evaluate(el => el.classList.contains('checked')),
      '3e pain devient checkable après désélection d\'un autre'
    )

    // Attend l'autosave + vérifie la DB
    await page.waitForTimeout(1500)
    const dbRow = db.prepare(`
      SELECT pain_points FROM qualification_calls WHERE id = ?
    `).get(createdCallId)
    let pains = []
    try { pains = JSON.parse(dbRow?.pain_points || '[]') } catch {}
    assert.equal(pains.length, 2, `DB doit contenir exactement 2 pains, trouvé ${pains.length}: ${JSON.stringify(pains)}`)
    assert.ok(pains.includes('tied_to_farm') && pains.includes('hiring'),
      `DB doit contenir tied_to_farm et hiring, trouvé: ${JSON.stringify(pains)}`)
  })
})
