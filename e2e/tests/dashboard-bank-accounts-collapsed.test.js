const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune config modifiée.
describe('Dashboard — le détail des comptes bancaires est replié par défaut', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('Le tableau des comptes est masqué au chargement et se déplie au clic', async () => {
    await page.goto(URL + '/dashboard/soldes-bancaires', { waitUntil: 'domcontentloaded' })

    const card = page.locator('[data-testid="section-bank-accounts"]')
    await card.waitFor({ timeout: 20000 })
    await card.scrollIntoViewIfNeeded()

    const panel = page.locator('[data-testid="dashboard-bank-accounts"]')
    if (!(await panel.isVisible().catch(() => false))) {
      await card.locator('h2').first().click()
    }

    await page.locator('[data-testid="dashboard-treasury"], :text("Impossible de charger les soldes")').first()
      .waitFor({ timeout: 30000 })
    const cardText = await card.innerText()
    if (cardText.includes('Impossible de charger les soldes')) {
      console.warn('QB indisponible — test toléré')
      return
    }

    // La trésorerie reste visible d'emblée.
    await assert.doesNotReject(page.locator('[data-testid="treasury-amount"]').waitFor({ timeout: 10000 }))

    // Le détail compte par compte est replié par défaut.
    const detail = panel.locator('[data-testid="bank-accounts-detail"]')
    assert.equal(await detail.count(), 0, 'le détail des comptes est visible alors qu\'il devrait être replié')

    const toggle = panel.locator('[data-testid="bank-accounts-detail-toggle"]')
    await toggle.waitFor({ timeout: 10000 })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')

    // Un clic déplie le tableau.
    await toggle.click()
    await detail.waitFor({ timeout: 5000 })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    const rows = await detail.locator('table tbody tr').count()
    assert.ok(rows > 1, `le tableau déplié devrait lister des comptes (lignes: ${rows})`)
    assert.ok((await detail.innerText()).includes('Trésorerie nette'), 'le total « Trésorerie nette » manque dans le détail')

    // Un second clic le replie à nouveau.
    await toggle.click()
    await detail.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  })
})
