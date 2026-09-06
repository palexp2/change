const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("Codes d'activité — UI sans description", () => {
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

  test('le formulaire d\'ajout n\'a pas de champ Description', async () => {
    await page.goto(`${URL}/codes-activite`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Codes d\'activité")', { timeout: 10000 })
    const descLabel = await page.locator('label', { hasText: /Description/i }).count()
    assert.strictEqual(descLabel, 0, "aucun label 'Description' ne doit apparaître")
  })

  test('la table n\'a pas de colonne Description', async () => {
    const header = await page.locator('th', { hasText: 'Description' }).count()
    assert.strictEqual(header, 0, "la colonne 'Description' doit être retirée")
  })

  test('le bouton Ajouter crée toujours un code (sans description)', async () => {
    const tag = `NODESC-${Date.now().toString(36).toUpperCase()}`
    await page.fill('input[placeholder*="Formation"]', tag)
    await page.click('button:has-text("Ajouter")')
    await page.locator(`input[value="${tag}"]`).first().waitFor({ timeout: 8000 })

    // Cleanup
    await page.evaluate(async ({ name }) => {
      const token = localStorage.getItem('erp_token')
      const all = await fetch('/erp/api/activity-codes?include_inactive=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const c = (all.data || all).find(c => c.name === name)
      if (c) {
        await fetch(`/erp/api/activity-codes/${c.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
    }, { name: tag })
  })
})
