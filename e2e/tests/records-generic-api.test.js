// API de mutation générique (phase 1) — PATCH/DELETE /api/records/:table/:id
// piloté par le registre server/src/db/recordRegistry.js.
//
// Couvre : update partiel des champs autorisés, coercions (bool/trim),
// validation (non-nullable, aucun champ modifiable), 404 table non gérée,
// soft delete (activity_codes) vs hard delete (vacations).
//
// Cleanup : les activity_codes créés sont supprimés (soft) via la route dédiée
// dans after() ; les vacations sont hard-deletées par le test lui-même, mais on
// garde un filet de sécurité dans after() au cas où un assert échouerait avant.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Records generic API — PATCH/DELETE /api/records/:table/:id', () => {
  let browser, ctx, page
  const createdCodeIds = []
  const createdVacationIds = []
  const tag = Date.now().toString(36).toUpperCase()

  // Petit helper exécuté dans le navigateur : fetch authentifié → { status, body }.
  async function apiCall(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      let parsed = null
      try { parsed = await r.json() } catch { parsed = null }
      return { status: r.status, body: parsed }
    }, { method, path, body })
  }

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
    if (page) {
      await page.evaluate(async ({ codes, vacs }) => {
        const token = localStorage.getItem('erp_token')
        for (const id of codes) {
          await fetch(`/erp/api/activity-codes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
        }
        for (const id of vacs) {
          await fetch(`/erp/api/vacations/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
        }
      }, { codes: createdCodeIds, vacs: createdVacationIds })
    }
    await browser?.close()
  })

  test('404 pour une table non enregistrée dans le registre', async () => {
    const res = await apiCall('PATCH', '/records/companies/whatever-id', { name: 'x' })
    assert.strictEqual(res.status, 404)
    assert.match(res.body.error || '', /non gérée|inconnue/i)
  })

  test('PATCH activity_codes — update partiel + coercion bool + trim', async () => {
    // Création via la route dédiée (la création reste hand-rollée en phase 1).
    const created = await apiCall('POST', '/activity-codes', { name: `GenAPI ${tag}` })
    assert.strictEqual(created.status, 201)
    createdCodeIds.push(created.body.id)
    const id = created.body.id
    const updatedAtBefore = created.body.updated_at

    // PATCH via l'API générique : trim du name, description, bool actif/payable.
    const res = await apiCall('PATCH', `/records/activity_codes/${id}`, {
      name: `  GenAPI ${tag} edited  `,
      description: 'via generic api',
      active: false,
      payable: 1,
    })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.name, `GenAPI ${tag} edited`, 'name doit être trimmé (trimOrNull)')
    assert.strictEqual(res.body.description, 'via generic api')
    assert.strictEqual(res.body.active, 0, 'active=false → 0 (toBool)')
    assert.strictEqual(res.body.payable, 1, 'payable=1 → 1 (toBool)')
    assert.ok(res.body.updated_at && res.body.updated_at !== updatedAtBefore, 'updated_at doit être rafraîchi')
  })

  test('PATCH activity_codes — name vide rejeté (nonNullable) 400', async () => {
    const id = createdCodeIds[0]
    const res = await apiCall('PATCH', `/records/activity_codes/${id}`, { name: '   ' })
    assert.strictEqual(res.status, 400)
    assert.match(res.body.error || '', /cannot be empty|name/i)
  })

  test('PATCH activity_codes — aucun champ modifiable fourni 400', async () => {
    const id = createdCodeIds[0]
    // created_at n'est pas dans `allowed` → ignoré → setClause vide → 400.
    const res = await apiCall('PATCH', `/records/activity_codes/${id}`, { created_at: '2020-01-01' })
    assert.strictEqual(res.status, 400)
    assert.match(res.body.error || '', /aucun champ/i)
  })

  test('PATCH activity_codes — 404 si record inexistant', async () => {
    const res = await apiCall('PATCH', '/records/activity_codes/does-not-exist', { name: 'x' })
    assert.strictEqual(res.status, 404)
  })

  test('DELETE activity_codes — soft delete (GET dédié 404, record conservé)', async () => {
    const created = await apiCall('POST', '/activity-codes', { name: `GenDel ${tag}` })
    assert.strictEqual(created.status, 201)
    const id = created.body.id
    createdCodeIds.push(id)

    const del = await apiCall('DELETE', `/records/activity_codes/${id}`)
    assert.strictEqual(del.status, 200)
    assert.strictEqual(del.body.success, true)

    // La route dédiée filtre deleted_at IS NULL → 404 après soft delete.
    const get = await apiCall('GET', `/activity-codes/${id}`)
    assert.strictEqual(get.status, 404, 'soft delete : GET doit renvoyer 404')
  })

  test('vacations — PATCH (coercion paid) + DELETE hard via API générique', async () => {
    // Besoin d'un employé existant pour créer une vacation.
    const emps = await apiCall('GET', '/employees?limit=all')
    const list = Array.isArray(emps.body) ? emps.body : (emps.body.data || [])
    if (!list.length) {
      console.log('[skip] aucun employé en base — section vacations ignorée')
      return
    }
    const empId = list[0].id

    const created = await apiCall('POST', '/vacations', {
      employee_id: empId, start_date: '2031-01-05', end_date: '2031-01-09', paid: true, notes: `E2E ${tag}`,
    })
    assert.strictEqual(created.status, 201)
    const id = created.body.id
    createdVacationIds.push(id)

    // PATCH générique : paid=false → 0 (toBoolDefaultTrue), notes mis à jour.
    const patched = await apiCall('PATCH', `/records/vacations/${id}`, { paid: false, notes: `E2E ${tag} edited` })
    assert.strictEqual(patched.status, 200)
    assert.strictEqual(patched.body.paid, 0, 'paid=false → 0')
    assert.strictEqual(patched.body.notes, `E2E ${tag} edited`)

    // DELETE générique : hard delete (vacations n'a pas de deleted_at).
    const del = await apiCall('DELETE', `/records/vacations/${id}`)
    assert.strictEqual(del.status, 200)
    assert.strictEqual(del.body.success, true)
    // Déjà supprimé → retirer du filet de sécurité after().
    createdVacationIds.length = 0

    const get = await apiCall('GET', `/vacations?limit=all`)
    const after = Array.isArray(get.body) ? get.body : (get.body.data || [])
    assert.ok(!after.find(v => v.id === id), 'hard delete : la vacation ne doit plus exister')
  })
})
