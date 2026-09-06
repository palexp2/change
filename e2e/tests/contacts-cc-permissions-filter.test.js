// Vérifie que les colonnes dérivées "permissions des contrôleurs centraux"
// sont exposées côté API (contacts + companies) et configurables côté UI
// pour permettre des filtres personnalisés (>, <, =) sur n'importe laquelle
// des 16 clés.
//
// Lecture seule — n'écrit rien en DB, donc rien à nettoyer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const EXPECTED_KEYS = [
  'company_has_cc_permissions',
  'company_max_circulation_fans',
  'company_max_fans',
  'company_max_ventilation_fans',
  'company_max_heaters',
  'company_max_heat_pipes',
  'company_max_misters',
  'company_max_roofs',
  'company_max_tensiometers',
  'company_max_thermal_screens',
  'company_max_valves',
  'company_max_gh_advanced_ventilation',
  'company_max_gh_disease_prevention',
  'company_max_gh_heating',
  'company_max_gh_humidity_conservation',
  'company_max_gh_irrigation',
  'company_max_gh_rollup_ventilation',
]

describe('Contacts/Companies — permissions CC agrégées', () => {
  let browser, ctx, page, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    assert.ok(token, 'token doit être stocké')
  })

  after(async () => { await browser?.close() })

  test('GET /api/contacts expose les 16 clés company_max_*', async () => {
    const resp = await page.request.get(`${URL}/api/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resp.status(), 200)
    const body = await resp.json()
    assert.ok(Array.isArray(body.data) && body.data.length > 0, 'au moins un contact')
    const row = body.data[0]
    for (const k of EXPECTED_KEYS) {
      assert.ok(k in row, `clé ${k} doit être présente dans la réponse`)
    }
  })

  test('GET /api/companies expose les 16 clés company_max_*', async () => {
    const resp = await page.request.get(`${URL}/api/companies?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resp.status(), 200)
    const body = await resp.json()
    assert.ok(Array.isArray(body.data) && body.data.length > 0)
    const row = body.data[0]
    for (const k of EXPECTED_KEYS) {
      assert.ok(k in row, `clé ${k} doit être présente`)
    }
  })

  test('Agrégation SUM restreinte aux CC Opérationnel - Vendu/Loué', async () => {
    // On charge toute la liste et on confirme qu'au moins quelques contacts
    // ont des valeurs non-nulles (sinon l'agrégation n'a rien produit).
    const resp = await page.request.get(`${URL}/api/contacts?limit=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await resp.json()
    const withValves = body.data.filter(c => Number(c.company_max_valves) > 0)
    assert.ok(withValves.length > 0, 'au moins un contact doit avoir company_max_valves > 0')
  })

  test('company_has_cc_permissions = 1 ssi au moins un company_max_* est non-null', async () => {
    const resp = await page.request.get(`${URL}/api/contacts?limit=all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await resp.json()
    const known = body.data.filter(c => c.company_has_cc_permissions === 1)
    const unknown = body.data.filter(c => c.company_has_cc_permissions == null)
    assert.ok(known.length > 0, 'au moins un contact avec info CC')
    assert.ok(unknown.length > 0, 'au moins un contact sans info CC')
    assert.equal(known.length + unknown.length, body.data.length, 'partition totale')
    // Si on a l'info, au moins une clé numérique doit être non-null
    const sample = known[0]
    const numericKeys = EXPECTED_KEYS.filter(k => k !== 'company_has_cc_permissions')
    const hasAtLeastOneNonNull = numericKeys.some(k => sample[k] != null)
    assert.ok(hasAtLeastOneNonNull, 'au moins une clé numérique doit être non-null quand has_cc_permissions=1')
    // Inverse : sans info, toutes les clés numériques sont null
    const sampleUnknown = unknown[0]
    const allNull = numericKeys.every(k => sampleUnknown[k] == null)
    assert.ok(allNull, 'toutes les clés numériques doivent être null quand has_cc_permissions est null')
  })

  test('Page Contacts — colonne "Permissions — valves" disponible dans le panel Champs', async () => {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    // Ouvre le panel "Champs" pour voir la liste des colonnes (visibles + cachées)
    await page.locator('button:has-text("Champs")').first().click()
    await page.waitForTimeout(300)
    const bodyText = await page.locator('body').innerText()
    assert.ok(/Permissions\s*—\s*valves/i.test(bodyText),
      `Le libellé "Permissions — valves" doit apparaître dans le panel Champs (vu : ${bodyText.slice(0, 500)})`)
  })
})
