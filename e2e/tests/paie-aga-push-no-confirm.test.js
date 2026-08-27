const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la publication QB (répartition de paie & AGA) ne demande plus de
// confirmation avant de pousser. Les appels réseau de publication sont
// interceptés et remplacés par une réponse simulée : aucune écriture réelle
// n'est créée dans QuickBooks ni en base.
describe('Publication paie & AGA — sans confirmation', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('répartition de paie : "Publier sur QB" pousse directement, sans confirm()', async () => {
    let dialogFired = false
    page.on('dialog', d => { dialogFired = true; d.dismiss() })

    let requestSent = false
    await page.route('**/api/paies/*/repartition-push', async route => {
      requestSent = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ qb_journal_entry_id: 999999999, qb_journal_entry_url: null }) })
    })

    await page.goto(URL + '/paies', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=Paies', { timeout: 15000 })
    const row = page.locator('text=/^#?7$|Complété|Envoyés/').first()
    await row.click({ timeout: 15000 }).catch(() => {})
    const section = page.locator('[data-testid="paie-repartition"]')
    const attached = await section.waitFor({ state: 'attached', timeout: 15000 }).then(() => true).catch(() => false)
    assert.ok(attached, 'section répartition non atteinte')

    const btn = section.locator('[data-testid="paie-repartition-push"]')
    const alreadyPushed = await btn.count() === 0
    if (alreadyPushed) {
      console.warn('paie déjà publiée — vérification confirm() ininterprétable sur ce record')
      await page.unroute('**/api/paies/*/repartition-push')
      return
    }
    await btn.click()
    await page.waitForFunction(() => true, {}, { timeout: 500 }).catch(() => {})
    await page.waitForSelector('text=/Publiée — JE QuickBooks #999999999/', { timeout: 10000 })
    assert.equal(dialogFired, false, 'un dialogue de confirmation est apparu')
    assert.ok(requestSent, 'la requête de publication n\'a pas été envoyée')
    await page.unroute('**/api/paies/*/repartition-push')
  })

  test('assurance collective (AGA) : "Publier sur QB" pousse directement, sans confirm()', async () => {
    let dialogFired = false
    page.on('dialog', d => { dialogFired = true; d.dismiss() })

    let requestSent = false
    await page.route('**/api/paies/aga-repartition/push', async route => {
      requestSent = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ qb_purchase_id: 999999999, qb_purchase_url: null }) })
    })

    await page.goto(URL + '/comptabilite', { waitUntil: 'domcontentloaded' })
    const card = page.locator('[data-testid="compta-aga"]')
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.scrollIntoViewIfNeeded()
    const input = card.locator('[data-testid="compta-aga-amount"]')
    await input.fill('2 737,95')
    await input.blur()
    const btn = card.locator('[data-testid="compta-aga-push"]')
    await btn.waitFor({ state: 'attached', timeout: 15000 })
    await btn.click()
    await card.locator('text=/Publiée — dépense #999999999/').waitFor({ timeout: 10000 })
    assert.equal(dialogFired, false, 'un dialogue de confirmation est apparu')
    assert.ok(requestSent, 'la requête de publication n\'a pas été envoyée')
    await page.unroute('**/api/paies/aga-repartition/push')
  })
})
