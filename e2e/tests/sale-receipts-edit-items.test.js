const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les lignes d'articles d'un reçu peuvent être éditées depuis la
// fiche détail : ajout, modification, suppression, persistance en DB. Le test
// sauvegarde le tableau items[] original et le restaure dans after().

describe('Extraction de données : édition des lignes d\'articles', () => {
  let browser, ctx, page
  let token, receiptId, originalItems

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const candidate = body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : au moins un reçu status=done est requis')
    receiptId = candidate.id
    originalItems = candidate.items || []

    await page.goto(URL + '/sale-receipts/' + receiptId, { waitUntil: 'networkidle' })
    await page.getByTestId('receipt-item-add').waitFor({ state: 'visible', timeout: 10000 })
  })

  after(async () => {
    if (receiptId && token) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { items: originalItems },
      })
    }
    await browser?.close()
  })

  test('ajouter une ligne, la remplir et l\'enregistrer', async () => {
    const beforeCount = await page.locator('[data-testid^="receipt-item-row-"]').count()

    const btn = page.getByTestId('receipt-item-add')
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    // L'ajout déclenche un autosave côté client (effet sur items.length). On
    // attend que la nouvelle ligne soit visible dans le DOM.
    await page.locator(`[data-testid="receipt-item-row-${beforeCount}"]`).waitFor({ state: 'visible', timeout: 5000 })

    const row = page.locator(`[data-testid="receipt-item-row-${beforeCount}"]`)
    await row.locator('input').nth(0).fill('Ligne test E2E')
    await row.locator('input').nth(1).fill('42.50')
    await row.locator('input').nth(1).blur()
    await page.waitForTimeout(800)

    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const added = body.items[beforeCount]
    assert.ok(added, `La ligne ${beforeCount} doit exister en DB après ajout`)
    assert.equal(added.description, 'Ligne test E2E')
    assert.equal(added.total, 42.5, 'Le total saisi doit être persisté')
  })

  test('supprimer une ligne persiste en DB', async () => {
    const beforeCount = await page.locator('[data-testid^="receipt-item-row-"]').count()
    assert.ok(beforeCount > 0, 'Préalable : au moins une ligne à supprimer')

    await page.getByTestId(`receipt-item-remove-${beforeCount - 1}`).click()
    await page.waitForTimeout(600)

    const resp = await page.request.get(URL + '/api/sale-receipts/' + receiptId, {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    assert.equal(body.items.length, beforeCount - 1, `Le serveur doit avoir ${beforeCount - 1} lignes après suppression`)
  })
})
