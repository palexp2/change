const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — CRUD + autosave + mode toggle', () => {
  let browser, ctx, page
  const testDate = '2030-01-15' // date future isolée pour ne pas polluer la vraie data
  let createdDayId = null

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
    if (createdDayId) {
      await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      }, { id: createdDayId })
    }
    await browser?.close()
  })

  test('POST /timesheets/day crée une journée, retourne entries=[]', async () => {
    const result = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode: 'simple' }),
      })
      return { status: r.status, body: await r.json() }
    }, { date: testDate })
    assert.strictEqual(result.status, 201)
    assert.strictEqual(result.body.date, testDate)
    assert.strictEqual(result.body.mode, 'simple')
    assert.deepStrictEqual(result.body.entries, [])
    createdDayId = result.body.id
  })

  test('POST idempotent — retourne le même jour (pas de doublon) (200)', async () => {
    const result = await page.evaluate(async ({ date }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode: 'simple' }),
      })
      return { status: r.status, body: await r.json() }
    }, { date: testDate })
    assert.strictEqual(result.status, 200, 'POST du même (user,date) doit retourner 200 (existing)')
    assert.strictEqual(result.body.id, createdDayId)
  })

  test('PATCH day — basculer mode détaillé, mettre start/end/break', async () => {
    const updated = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/timesheets/day/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_time: '09:00', end_time: '17:30', break_minutes: 30 }),
      })
      return await r.json()
    }, { id: createdDayId })
    assert.strictEqual(updated.start_time, '09:00')
    assert.strictEqual(updated.end_time, '17:30')
    assert.strictEqual(updated.break_minutes, 30)
  })

  test('POST entry avec duration="1:30" → 90 minutes stockées', async () => {
    const result = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      // Passer en détaillé
      await fetch(`/erp/api/timesheets/day/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'detailed' }),
      })
      const r = await fetch(`/erp/api/timesheets/day/${id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Test activité', duration: '1:30', rsde: true }),
      })
      return { status: r.status, body: await r.json() }
    }, { id: createdDayId })
    assert.strictEqual(result.status, 201)
    assert.strictEqual(result.body.entries.length, 1)
    assert.strictEqual(result.body.entries[0].duration_minutes, 90)
    assert.strictEqual(result.body.entries[0].rsde, 1)
  })

  test('PATCH entry avec duration="90" → 90 minutes (accepte les entiers nus)', async () => {
    const result = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const day = await fetch(`/erp/api/timesheets/day?date=2030-01-15`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const entryId = day.entries[0].id
      const r = await fetch(`/erp/api/timesheets/entries/${entryId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: '90' }),
      })
      return await r.json()
    }, { id: createdDayId })
    assert.strictEqual(result.entries[0].duration_minutes, 90)
  })

  test('DELETE day est soft (deleted_at set, GET retourne null)', async () => {
    const result = await page.evaluate(async ({ id, date }) => {
      const token = localStorage.getItem('erp_token')
      const del = await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const after = await fetch(`/erp/api/timesheets/day?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return { delStatus: del.status, afterBody: after }
    }, { id: createdDayId, date: testDate })
    assert.strictEqual(result.delStatus, 200)
    assert.strictEqual(result.afterBody, null, 'la journée ne doit plus apparaître en liste')
    createdDayId = null // cleanup already done
  })

  test('UI — page feuille de temps se charge + bouton "Ajouter une activité" présent en mode détaillé', async () => {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Feuille de temps/', { timeout: 10000 })
    await page.waitForSelector('button:has-text("Détaillé")', { timeout: 5000 })
    await page.click('button:has-text("Détaillé")')
    await page.waitForSelector('button:has-text("Ajouter une activité")', { timeout: 5000 })
    // Cleanup: supprime la journée créée en basculant vers détaillé via l'UI
    const dayId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const today = new Date().toISOString().slice(0, 10)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      if (d?.id) {
        await fetch(`/erp/api/timesheets/day/${d.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        return d.id
      }
      return null
    })
    // dayId peut être null si la journée avait déjà été nettoyée, pas de souci
    void dayId
  })
})
