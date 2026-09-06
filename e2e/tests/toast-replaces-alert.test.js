const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les erreurs côté API affichent un toast et non un window.alert.
// On force une erreur en tentant une opération interdite via l'UI d'un flow
// connu, et on s'assure qu'aucun window.alert ne s'ouvre.
describe('Toasts remplacent les window.alert', () => {
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

  test('erreur backend → toast (pas de window.alert)', async () => {
    const nativeDialogs = []
    page.on('dialog', d => { nativeDialogs.push(d.message()); d.dismiss() })

    await page.goto(`${URL}/codes-activite`, { waitUntil: 'networkidle' })

    // Intercepter l'API POST activity-codes pour forcer une erreur 400
    await page.route('**/api/activity-codes', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: '__test_toast_error__' }),
        })
      }
      return route.continue()
    })

    // Remplir le formulaire d'ajout et soumettre
    const nameInput = page.locator('input[placeholder*="Formation"]').first()
    await nameInput.waitFor({ state: 'visible', timeout: 5000 })
    await nameInput.fill(`__toast_test_${Date.now()}`)
    await page.locator('form button[type="submit"]').first().click()

    // Un toast d'erreur doit apparaître avec le message
    const toast = page.locator('text=__test_toast_error__').first()
    await toast.waitFor({ state: 'visible', timeout: 3000 })

    // Aucun window.alert ne doit avoir été ouvert
    assert.equal(nativeDialogs.length, 0, `aucun window.alert attendu — reçu: ${nativeDialogs.join(', ')}`)
  })
})
