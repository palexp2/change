const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Pour les entrées sur un code d'activité non payable :
// - la ligne reste en surbrillance ambre (bg-amber-50/40)
// - le sous-texte "Non payable — exclu du total" n'apparaît plus
describe('FeuilleDeTemps — surbrillance non payable sans mention texte', () => {
  let browser, ctx, page
  const createdCodeIds = []
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
    await page.evaluate(async ({ codes, days }) => {
      const token = localStorage.getItem('erp_token')
      for (const id of days) {
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
      for (const id of codes) {
        await fetch(`/erp/api/activity-codes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
    }, { codes: createdCodeIds, days: createdDayIds })
    await browser?.close()
  })

  test('ligne en bg-amber, pas de mention "Non payable — exclu du total"', async () => {
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `NonPayUI-${Date.now()}`, payable: false }),
      }).then(r => r.json())
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
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '1:30' }),
      })
      return { codeId: code.id, dayId: day.id }
    })
    createdCodeIds.push(setup.codeId)
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })

    // Surbrillance ambre conservée
    const highlightedRow = page.locator('tr.bg-amber-50\\/40').first()
    await highlightedRow.waitFor({ timeout: 5000 })
    assert.ok(await highlightedRow.isVisible(), 'la ligne non payable doit rester en surbrillance ambre')

    // Mention textuelle retirée
    const mentions = await page.locator('text=Non payable — exclu du total').count()
    assert.equal(mentions, 0, 'la mention "Non payable — exclu du total" ne doit plus apparaître')
  })
})
