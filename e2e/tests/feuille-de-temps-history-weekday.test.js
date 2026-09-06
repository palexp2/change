const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie : chaque ligne de la sidebar historique affiche le jour de la semaine
// (lun., mar., …) devant la date.
describe('FeuilleDeTemps — historique : jour de la semaine affiché', () => {
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

  test('la ligne d\'historique affiche l\'abréviation du jour devant la date', async () => {
    // Crée un jour il y a 5 jours (assez récent pour la fenêtre de 12 semaines)
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const d = new Date(); d.setDate(d.getDate() - 5)
      const date = d.toISOString().slice(0, 10)
      const existing = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode: 'simple', start_time: '09:00', end_time: '12:00' }),
      }).then(r => r.json())
      // Jour attendu — même calcul que weekdayShort() dans la page
      const expected = new Date(date + 'T00:00:00').toLocaleDateString('fr-CA', { weekday: 'short' })
      return { date, id: day.id, expected }
    })
    createdDayIds.push(setup.id)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="history-day-row-${setup.date}"]`, { timeout: 10000 })

    const rowText = await page.locator(`[data-testid="history-day-row-${setup.date}"]`).innerText()
    assert.ok(
      rowText.toLowerCase().includes(setup.expected.toLowerCase()),
      `la ligne doit contenir "${setup.expected}" ; reçu: "${rowText}"`,
    )
    // L'abréviation précède la date
    const idxDay = rowText.toLowerCase().indexOf(setup.expected.toLowerCase())
    const idxDate = rowText.indexOf(setup.date)
    assert.ok(idxDay < idxDate, `le jour ("${setup.expected}") doit précéder la date ; reçu: "${rowText}"`)
  })
})
