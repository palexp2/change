const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le nouvel onglet Rabais dans la slide Proposal (vue assistant) :
// - L'onglet existe à côté de Script / Battle Cards / Quote
// - Le tableau contient les 8 partenaires (Masterclass, EFAO, Clay Bottom Farm,
//   Neversink Farm, CGN, NoTill Growers, NYFCC, OCO)
// - Les codes promo sont rendus dans <code>
// - Quand Rabais est actif, les autres phase-blocks (proposal/battlecards/quote)
//   sont masqués
describe('Guide d\'appel — onglet Rabais (Proposal)', () => {
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

  test('onglet Rabais existe, contient les 8 partenaires avec codes promo, isole le contenu', async () => {
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

    // Navigue vers la Proposal slide (index 6)
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.assistant-section-label:has-text("The proposal")').waitFor({ state: 'visible', timeout: 3000 })

    // Onglet Rabais doit exister, après Quote
    const tabs = await frame.locator('.step-tab').allTextContents()
    const trimmed = tabs.map(t => t.trim())
    assert.deepEqual(trimmed, ['Script', 'Battle Cards', 'Quote', 'Rabais'], 'Ordre attendu : Script, Battle Cards, Quote, Rabais')

    const rabaisTab = frame.locator('.step-tab[data-tab="rabais"]')
    await rabaisTab.click()
    await frame.locator('.rabais-table').waitFor({ state: 'visible', timeout: 3000 })

    // Vérifie les 8 partenaires
    const partners = await frame.locator('.rabais-partner').allTextContents()
    assert.deepEqual(
      partners.map(p => p.trim()),
      [
        'Masterclass du Jardinier Maraîcher',
        'EFAO',
        'Clay Bottom Farm',
        'Neversink Farm',
        'CGN',
        'NoTill Growers',
        'NYFCC',
        'OCO',
      ],
      'Les 8 partenaires doivent être listés dans l\'ordre'
    )

    // Vérifie les rabais (espace insécable ou normal — on normalise)
    const amounts = await frame.locator('.rabais-amount').allTextContents()
    assert.deepEqual(
      amounts.map(a => a.replace(/\s+/g, ' ').trim()),
      ['10 %', '10 %', '15 %', '20 %', '10 %', '15 %', '10 %', '10 %'],
      'Les rabais doivent matcher'
    )

    // Codes promo en <code>
    const codes = await frame.locator('.rabais-notes code').allTextContents()
    assert.deepEqual(
      codes,
      ['CLAYBOTTOMFARM22', 'NEVERSINKFARM22', 'CNG2023', 'NOTILLGROWERS2023', 'ORISHA24NTG', 'NYFCC-ORISHA2023'],
      'Codes promo dans l\'ordre attendu'
    )

    // Vérifie que les autres phase-blocks sont masqués quand Rabais est actif
    // Le quote-builder ne doit pas être visible
    const quoteBuilderVisible = await frame.locator('.quote-builder').isVisible()
    assert.equal(quoteBuilderVisible, false, 'Le quote builder doit être masqué quand Rabais est actif')

    // Le script "Qualify" du proposal phase ne doit pas être visible
    const proposalQuoteVisible = await frame.locator('.phase-block[data-phase="proposal"] .step-quote').first().isVisible()
    assert.equal(proposalQuoteVisible, false, 'Le script proposal doit être masqué quand Rabais est actif')
  })
})
