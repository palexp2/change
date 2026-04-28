const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie l'ordre des colonnes dans le tableau d'édition (mode détaillé) :
// Début | Code d'activité | Fin | Description | Durée | RSDE
describe('FeuilleDeTemps — ordre colonnes mode détaillé', () => {
  let browser, ctx, page
  const createdDayIds = []

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

  after(async () => {
    await page.evaluate(async ({ days }) => {
      const token = localStorage.getItem('erp_token')
      for (const id of days) {
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
    }, { days: createdDayIds })
    await browser?.close()
  })

  test('en-têtes dans l\'ordre attendu : Description après Fin', async () => {
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const today = new Date().toISOString().slice(0, 10)
      const existing = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today, mode: 'detailed' }),
      }).then(r => r.json())
      return { dayId: day.id }
    })
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const headers = await page.locator('main thead th').allTextContents()
    const cleaned = headers.map(h => h.trim()).filter(Boolean)
    assert.deepEqual(
      cleaned,
      ['Début', "Code d'activité", 'Fin', 'Description', 'Durée', 'RSDE'],
      `ordre attendu non respecté ; reçu: ${JSON.stringify(cleaned)}`,
    )
  })
})
