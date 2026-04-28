const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie : le jour en cours d'édition est mis en surbrillance dans la sidebar historique,
// et la mise en surbrillance suit la date sélectionnée (changement de jour via la nav).
describe('FeuilleDeTemps — historique : jour actif en surbrillance', () => {
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

  test('jour cliqué prend la surbrillance ; un jour différent ne l\'a pas', async () => {
    // Crée 2 jours dans l'historique
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const mk = (offset) => {
        const d = new Date(); d.setDate(d.getDate() - offset)
        return d.toISOString().slice(0, 10)
      }
      const dates = [mk(7), mk(3)]
      const ids = []
      for (const date of dates) {
        const existing = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        if (existing?.id) {
          await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        }
        const day = await fetch('/erp/api/timesheets/day', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, mode: 'simple', start_time: '09:00', end_time: '12:00' }),
        }).then(r => r.json())
        ids.push(day.id)
      }
      return { dates, ids }
    })
    createdDayIds.push(...setup.ids)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    const [oldDate, recentDate] = setup.dates

    // Cliquer le jour le plus ancien — doit devenir actif
    await page.locator(`[data-testid="history-day-row-${oldDate}"]`).click()
    await page.waitForFunction(
      d => document.querySelector(`[data-testid="history-day-row-${d}"]`)?.getAttribute('data-active') === 'true',
      oldDate,
      { timeout: 5000 }
    )
    const activeOnOld = await page.locator(`[data-testid="history-day-row-${oldDate}"]`).getAttribute('data-active')
    const activeOnRecent = await page.locator(`[data-testid="history-day-row-${recentDate}"]`).getAttribute('data-active')
    assert.equal(activeOnOld, 'true', `${oldDate} doit être actif`)
    assert.equal(activeOnRecent, 'false', `${recentDate} ne doit PAS être actif`)

    // Surbrillance visuelle (bg-indigo-50)
    const cls = await page.locator(`[data-testid="history-day-row-${oldDate}"]`).getAttribute('class')
    assert.ok(cls.includes('bg-indigo-50'), `la classe doit contenir bg-indigo-50 ; reçu: ${cls}`)

    // Cliquer l'autre jour — la surbrillance bascule
    await page.locator(`[data-testid="history-day-row-${recentDate}"]`).click()
    await page.waitForFunction(
      d => document.querySelector(`[data-testid="history-day-row-${d}"]`)?.getAttribute('data-active') === 'true',
      recentDate,
      { timeout: 5000 }
    )
    const activeOnOldAfter = await page.locator(`[data-testid="history-day-row-${oldDate}"]`).getAttribute('data-active')
    assert.equal(activeOnOldAfter, 'false', `${oldDate} ne doit plus être actif`)
  })

  test('layout : historique à gauche du formulaire d\'édition (lg)', async () => {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    // L'aside historique doit être à gauche de la zone d'édition (date nav).
    const asideBox = await page.locator('aside').first().boundingBox()
    const dateNavBox = await page.locator('text=/Total payable du jour/').first().boundingBox()
    assert.ok(asideBox, 'aside doit exister')
    assert.ok(dateNavBox, 'date nav doit exister')
    assert.ok(
      asideBox.x + asideBox.width <= dateNavBox.x + 5,
      `aside (right=${asideBox.x + asideBox.width}) doit être à gauche de la date nav (left=${dateNavBox.x})`,
    )
  })
})
