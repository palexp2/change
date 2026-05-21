const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que le formulaire Stripe (carte de crédit) est rendu au bas de l'onglet
// Quote du step Proposal. Ne déclenche pas de charge réelle — pas de clé Stripe en DB
// dans l'environnement local, et on ne veut pas créer de customer/subscription
// pendant un test E2E.
describe('Guide d\'appel — formulaire carte de crédit Stripe (Quote tab)', () => {
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

  test('formulaire Stripe Elements + bouton "Charge card" rendus au bas de l\'onglet Quote', async () => {
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

    // Aller directement à la slide Proposal (index 6)
    await frame.locator('body').evaluate(() => {
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(6)
    })
    await frame.locator('.assistant-section-label:has-text("The proposal")').waitFor({ state: 'visible', timeout: 3000 })

    // Quote tab doit exister et être actif par défaut sur le proposal step.
    const quoteTab = frame.locator('.step-tab[data-tab="quote"]')
    await quoteTab.waitFor({ state: 'visible', timeout: 3000 })
    await quoteTab.click()
    await frame.locator('.quote-builder').waitFor({ state: 'visible', timeout: 3000 })

    // La section paiement doit être présente, sous le total mensuel.
    await frame.locator('#quote-pay').waitFor({ state: 'visible', timeout: 3000 })
    const title = await frame.locator('.quote-pay-title').textContent()
    assert.match((title || '').trim(), /Pay by credit card/i)

    // Champs cardholder name + email + container Stripe Elements + bouton submit.
    await frame.locator('#quote-pay-name').waitFor({ state: 'visible', timeout: 2000 })
    await frame.locator('#quote-pay-email').waitFor({ state: 'visible', timeout: 2000 })
    await frame.locator('#quote-pay-card').waitFor({ state: 'visible', timeout: 2000 })
    await frame.locator('#quote-pay-submit').waitFor({ state: 'visible', timeout: 2000 })

    // Le bouton porte le bon label par défaut.
    const btnLabel = await frame.locator('#quote-pay-btn-label').textContent()
    assert.match((btnLabel || '').trim(), /Charge card/i)

    // Section rabais ad-hoc : présente, masquée par défaut, ouverte au check.
    await frame.locator('#quote-pay-discount').waitFor({ state: 'visible', timeout: 2000 })
    const initiallyOpen = await frame.locator('#quote-pay-discount').evaluate(el => el.classList.contains('open'))
    assert.equal(initiallyOpen, false, 'Le bloc discount doit être fermé par défaut')

    // Coche Apply discount → body apparaît.
    await frame.locator('#quote-pay-discount-on').check()
    await page.waitForTimeout(150)
    const opened = await frame.locator('#quote-pay-discount').evaluate(el => el.classList.contains('open'))
    assert.equal(opened, true, 'Le bloc discount doit s\'ouvrir après check')

    // Type % par défaut, suffix affiche %
    const suffix1 = await frame.locator('#quote-pay-discount-suffix').textContent()
    assert.equal((suffix1 || '').trim(), '%', 'Suffix doit être % par défaut')

    // Click $ off → suffix devient $
    await frame.locator('.quote-pay-seg[data-group="type"] button[data-type="amount"]').click()
    await page.waitForTimeout(100)
    const suffix2 = await frame.locator('#quote-pay-discount-suffix').textContent()
    assert.equal((suffix2 || '').trim(), '$', 'Suffix doit devenir $ après click $ off')

    // Click For N months → la ligne months doit apparaître
    await frame.locator('.quote-pay-seg[data-group="duration"] button[data-duration="repeating"]').click()
    await page.waitForTimeout(100)
    const monthsVisible = await frame.locator('.quote-pay-months-row').evaluate(el => getComputedStyle(el).display !== 'none')
    assert.equal(monthsVisible, true, 'La ligne months doit apparaître pour "For N months"')

    // Décoche pour repartir d'un état propre avant la suite.
    await frame.locator('#quote-pay-discount-on').uncheck()
    await page.waitForTimeout(100)

    // Attend que mountQuotePay ait fait son fetch de publishable-key.
    await page.waitForTimeout(800)

    // Vérifie l'état du formulaire selon la config Stripe :
    // - Si pas de publishable_key en DB → bouton désactivé + message d'erreur "Stripe is not configured"
    // - Sinon → on peut tester la validation côté client (nom/email manquants)
    const pkRow = db.prepare(
      "SELECT value FROM connector_config WHERE connector='stripe' AND key='publishable_key'"
    ).get()
    const hasKey = !!(pkRow && pkRow.value)

    if (!hasKey) {
      const disabled = await frame.locator('#quote-pay-submit').evaluate(el => el.disabled)
      assert.equal(disabled, true, 'sans publishable_key, le bouton doit être désactivé')
      const msg = await frame.locator('#quote-pay-msg').textContent()
      assert.match((msg || '').trim(), /Stripe is not configured/i,
        'sans publishable_key, un message "Stripe is not configured" doit apparaître')
    } else {
      // Stripe configuré → validation côté client doit empêcher le submit sans nom/email.
      await frame.locator('#quote-pay-submit').click()
      await page.waitForTimeout(300)
      const msg = await frame.locator('#quote-pay-msg').textContent()
      assert.match((msg || '').trim(), /name|email|Helper|Chief/i,
        'un message de validation doit apparaître au submit vide')
    }
  })
})
