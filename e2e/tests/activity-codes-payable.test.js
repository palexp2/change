const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe("Codes d'activité — flag payable", () => {
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

  test("POST activity-codes par défaut payable=1", async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `PayableTest-${Date.now()}` }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.body.payable, 1)
    createdCodeIds.push(res.body.id)
  })

  test("POST activity-codes avec payable=false persiste 0", async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `NonPayable-${Date.now()}`, payable: false }),
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.body.payable, 0)
    createdCodeIds.push(res.body.id)
  })

  test("PATCH activity-codes payable=false", async () => {
    const res = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/activity-codes/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payable: false }),
      })
      return { status: r.status, body: await r.json() }
    }, { id: createdCodeIds[0] })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.payable, 0)
  })

  test("timesheet entries exposent activity_code_payable via join", async () => {
    const res = await page.evaluate(async ({ payableId, nonPayableId }) => {
      const token = localStorage.getItem('erp_token')
      // Créer jour + deux entrées
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2030-06-01', mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: nonPayableId, duration: '2:00' }),
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: payableId, duration: '3:30' }),
      })
      const fresh = await fetch(`/erp/api/timesheets/day?date=2030-06-01`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return { dayId: day.id, entries: fresh.entries }
    }, { payableId: createdCodeIds[1] === undefined ? createdCodeIds[0] : createdCodeIds[0], nonPayableId: createdCodeIds[0] })
    createdDayIds.push(res.dayId)
    // Vérif: les deux entries ont activity_code_payable renseigné (0 ou 1)
    for (const e of res.entries) {
      assert.ok(e.activity_code_payable === 0 || e.activity_code_payable === 1,
        `activity_code_payable doit être 0 ou 1 (reçu: ${e.activity_code_payable})`)
    }
  })

  test("UI — page feuille de temps n'affiche que les heures payables dans le total", async () => {
    // Setup: un code payable, un non-payable; un jour avec une entrée de chaque
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const payable = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `UIPayable-${Date.now()}`, payable: true }),
      }).then(r => r.json())
      const nonPayable = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `UINonPayable-${Date.now()}`, payable: false }),
      }).then(r => r.json())
      const today = new Date().toISOString().slice(0, 10)
      // Reset any existing today's day
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
        body: JSON.stringify({ activity_code_id: payable.id, duration: '3:00' }), // 180 min — payable
      })
      await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: nonPayable.id, duration: '2:00' }), // 120 min — non payable
      })
      return { payableId: payable.id, nonPayableId: nonPayable.id, dayId: day.id }
    })
    createdCodeIds.push(setup.payableId, setup.nonPayableId)
    createdDayIds.push(setup.dayId)

    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Total payable du jour/', { timeout: 10000 })
    // Le total doit être 3:00, pas 5:00
    const totalText = await page.locator('.tabular-nums').first().textContent()
    assert.ok(totalText?.trim() === '3:00', `Total attendu "3:00" (payable seulement), reçu "${totalText}"`)
  })
})
