const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que le placeholder du champ « Cardholder name » du formulaire Stripe
// (slide Proposal, onglet Quote) reprend le « Contact's name » saisi dans le
// formulaire de qualification (slide 0). Le test pilote la slide view popup —
// c'est là que le vendeur remplit le Contact's name en pratique (slide-0 est
// hidden dans la vue assistant). Le broadcast sync la valeur vers l'iframe.
describe('Guide d\'appel — placeholder Cardholder name suit le Contact\'s name', () => {
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

  test('placeholder = Contact\'s name saisi en slide 0', async () => {
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

    // Ouvre la slide view en popup — c'est là que le vendeur tape le Contact's name.
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#qa-contact').waitFor({ state: 'visible', timeout: 5000 })

    // 1) Tape un Contact's name dans la slide view → broadcast → iframe → autosave
    const contactName = `E2E Cardholder ${Date.now()}`
    await slidePage.locator('#qa-contact').fill(contactName)
    await slidePage.locator('#qa-contact').blur()
    await page.waitForTimeout(1500) // broadcast + debounce + PATCH

    // Sanity check : la valeur de qa-contact est aussi présente dans l'iframe assistant
    const contactInIframe = await frame.locator('#qa-contact').inputValue()
    assert.equal(contactInIframe, contactName,
      'Le qa-contact dans l\'iframe doit être synchronisé via BroadcastChannel')

    // 2) Dans l'iframe assistant, naviguer vers la slide Proposal (index 6)
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.assistant-section-label:has-text("The proposal")').waitFor({ state: 'visible', timeout: 3000 })

    // 3) Activer l'onglet Quote
    const quoteTab = frame.locator('.step-tab[data-tab="quote"]')
    await quoteTab.waitFor({ state: 'visible', timeout: 3000 })
    await quoteTab.click()
    await frame.locator('#quote-pay-name').waitFor({ state: 'visible', timeout: 3000 })

    // 4) Le placeholder du Cardholder name doit valoir le Contact's name saisi.
    const placeholder = await frame.locator('#quote-pay-name').getAttribute('placeholder')
    assert.equal(placeholder, contactName,
      `placeholder doit valoir le Contact's name "${contactName}", reçu "${placeholder}"`)

    // 5) La valeur du champ reste vide — c'est juste un placeholder, pas une valeur.
    const value = await frame.locator('#quote-pay-name').inputValue()
    assert.equal(value, '', 'le champ ne doit pas être pré-rempli, juste le placeholder')
  })
})
