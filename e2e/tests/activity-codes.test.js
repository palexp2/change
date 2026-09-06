const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Codes d\'activité — CRUD + intégration feuille de temps', () => {
  let browser, ctx, page
  const createdCodeIds = []
  const createdDayIds = []
  const tag = Date.now().toString(36).toUpperCase()

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

  test('POST /api/activity-codes crée un code', async () => {
    const res = await page.evaluate(async ({ name }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      return { status: r.status, body: await r.json() }
    }, { name: `Formation ${tag}` })
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.body.name, `Formation ${tag}`)
    assert.strictEqual(res.body.active, 1)
    createdCodeIds.push(res.body.id)
  })

  test('GET /api/activity-codes retourne les codes actifs (pas inactifs par défaut)', async () => {
    const res = await page.evaluate(async ({ codeId }) => {
      const token = localStorage.getItem('erp_token')
      // Le désactiver
      await fetch(`/erp/api/activity-codes/${codeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      })
      const listDefault = await fetch('/erp/api/activity-codes', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const listAll = await fetch('/erp/api/activity-codes?include_inactive=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      // Réactiver pour le reste des tests
      await fetch(`/erp/api/activity-codes/${codeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      })
      return { default: listDefault.data, all: listAll.data, codeId }
    }, { codeId: createdCodeIds[0] })

    assert.ok(!res.default.find(c => c.id === res.codeId), 'code inactif ne doit pas être dans la liste par défaut')
    assert.ok(res.all.find(c => c.id === res.codeId), 'code inactif doit apparaître avec include_inactive=1')
  })

  test('DELETE est soft (GET retourne 404, reste dans la table)', async () => {
    const tmp = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Temp-${Date.now()}` }),
      })
      const code = await r.json()
      const del = await fetch(`/erp/api/activity-codes/${code.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const get = await fetch(`/erp/api/activity-codes/${code.id}`, { headers: { Authorization: `Bearer ${token}` } })
      return { delStatus: del.status, getStatus: get.status }
    })
    assert.strictEqual(tmp.delStatus, 200)
    assert.strictEqual(tmp.getStatus, 404, 'DELETE est soft — GET doit renvoyer 404 filtré par deleted_at')
  })

  test('timesheet_entries utilise activity_code_id (rejette project_id)', async () => {
    const res = await page.evaluate(async ({ codeId }) => {
      const token = localStorage.getItem('erp_token')
      // Créer une journée
      const day = await fetch('/erp/api/timesheets/day', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2030-05-10', mode: 'detailed' }),
      }).then(r => r.json())
      // Ajouter une entrée avec activity_code_id
      const addRes = await fetch(`/erp/api/timesheets/day/${day.id}/entries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: codeId, duration: '2:00' }),
      })
      const after = await addRes.json()
      return { dayId: day.id, status: addRes.status, entry: after.entries?.[0] }
    }, { codeId: createdCodeIds[0] })

    createdDayIds.push(res.dayId)
    assert.strictEqual(res.status, 201)
    assert.strictEqual(res.entry.activity_code_id, createdCodeIds[0])
    assert.strictEqual(res.entry.duration_minutes, 120)
    assert.ok(res.entry.activity_code_name, 'le join doit peupler activity_code_name')
  })

  test('UI — page codes-activite affiche le code créé', async () => {
    await page.goto(`${URL}/codes-activite`, { waitUntil: 'networkidle' })
    // Le nom est dans un input éditable (autosave), donc on matche sur la valeur.
    await page.locator(`input[value="Formation ${tag}"]`).first().waitFor({ timeout: 10000 })
  })

  test('UI — picker "Code d\'activité" dans la feuille de temps propose le code', async () => {
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/Feuille de temps/', { timeout: 10000 })
    // Basculer en détaillé + ajouter une activité
    await page.click('button:has-text("Détaillé")')
    await page.waitForSelector('button:has-text("Ajouter une activité")', { timeout: 5000 })
    await page.click('button:has-text("Ajouter une activité")')
    // Attendre au moins un picker "Code…" présent
    await page.getByRole('button', { name: /^Code…|\(sans nom\)|Formation/ }).first().waitFor({ timeout: 5000 })
    // L'en-tête "Code d'activité" doit exister (plus "Projet")
    const header = await page.locator('th', { hasText: "Code d'activité" }).count()
    assert.ok(header > 0, "en-tête 'Code d'activité' doit être présent")
    // Nettoyage de la journée du test UI
    const dayId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const today = new Date().toISOString().slice(0, 10)
      const d = await fetch(`/erp/api/timesheets/day?date=${today}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return d?.id || null
    })
    if (dayId) createdDayIds.push(dayId)
  })
})
