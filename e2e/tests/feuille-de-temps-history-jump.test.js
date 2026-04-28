const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Cliquer sur une ligne d'historique en bas doit :
// - changer la date affichée dans le menu d'édition du haut (pas d'accordéon)
// - scroller la page vers le haut
// - ne PAS faire apparaître de zone d'édition inline en dessous
describe('FeuilleDeTemps — historique : clic ligne ouvre édition du haut', () => {
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

  test('clic sur une date d\'historique → date du haut change, pas d\'accordéon', async () => {
    // Crée un jour passé pour l'historique (pas d'aujourd'hui pour bien voir le saut)
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const past = new Date()
      past.setDate(past.getDate() - 5)
      const pastDate = past.toISOString().slice(0, 10)
      // Reset si existe
      const existing = await fetch(`/erp/api/timesheets/day?date=${pastDate}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (existing?.id) {
        await fetch(`/erp/api/timesheets/day/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: pastDate, mode: 'simple', start_time: '09:00', end_time: '17:00' }),
      }).then(r => r.json())
      return { dayId: day.id, pastDate }
    })
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    // Scroll bas pour voir l'historique et que le clic puisse ensuite remonter
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }))
    await page.waitForTimeout(300)

    const row = page.locator(`[data-testid="history-day-row-${setup.pastDate}"]`)
    await row.waitFor({ timeout: 5000 })

    // Capture le label de date affiché en haut AVANT clic
    const dateHeaderLocator = page.locator('div.capitalize.tabular-nums').first()
    const before = await dateHeaderLocator.innerText()

    await row.click()

    // Le label de date du haut a changé pour refléter la date passée
    await page.waitForFunction(
      ({ before, pastDate }) => {
        const el = document.querySelector('div.capitalize.tabular-nums')
        if (!el) return false
        const cur = el.innerText
        // Le jour de mois doit apparaître dans le label localisé
        const dayOfMonth = parseInt(pastDate.slice(8, 10), 10)
        return cur !== before && cur.includes(String(dayOfMonth))
      },
      { before, pastDate: setup.pastDate },
      { timeout: 5000 }
    )

    // Le scroll est revenu en haut
    const scrollTop = await page.evaluate(() => window.scrollY)
    assert.ok(scrollTop < 100, `la page doit avoir remonté (scrollY=${scrollTop})`)

    // Aucun accordéon : pas de bg-slate-50/40 dans un <tr> sous le row cliqué
    const accordionRows = await page.locator('tr.bg-slate-50\\/40').count()
    assert.equal(accordionRows, 0, 'aucun accordéon ne doit s\'ouvrir dans l\'historique')
  })
})
