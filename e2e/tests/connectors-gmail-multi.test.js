const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteur Gmail — connexion de plusieurs comptes', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('bouton "Connecter un autre compte" visible dans le panneau Gmail', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Ouvre la carte Gmail
    const gmailCard = page.locator('button:has-text("Gmail")').first()
    await gmailCard.click()

    // Attendre que le panneau s'ouvre
    const addBtn = page.locator('button:has-text("Connecter un autre compte")')
    await addBtn.waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await addBtn.isVisible(), 'bouton "Connecter un autre compte" absent')
  })

  test('clic sur "Connecter un autre compte" redirige vers Google OAuth avec select_account', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Gmail")').first().click()

    const addBtn = page.locator('button:has-text("Connecter un autre compte")')
    await addBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Intercepter la navigation (sans la laisser aller jusqu'au bout sur Google)
    const [req] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/api/connectors/google/connect'), { timeout: 5000 }),
      addBtn.click(),
    ])
    assert.ok(req.url().includes('token='), 'token JWT manquant dans la redirection')

    // Suivre la redirection jusqu'à Google et vérifier prompt=select_account
    await page.waitForURL(u => u.toString().includes('accounts.google.com'), { timeout: 10000 })
    const finalUrl = page.url()
    assert.match(finalUrl, /prompt=.*select_account/, `prompt select_account absent: ${finalUrl}`)
  })
})
