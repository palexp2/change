// Masquage en lot de colonnes dans les DataTables : ⌘/Ctrl+clic (et Maj+clic)
// sur les en-têtes construit une multi-sélection, puis une seule action cache
// toutes les colonnes sélectionnées.
//
// Le test travaille sur une vue (pill) JETABLE créée par API et supprimée dans
// le hook after() — jamais sur une vue existante, dont les colonnes visibles
// sont partagées par tous les utilisateurs (autosave global).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp$/, '') + '/erp/api'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const PILL_COLS = ['order_number', 'company_name', 'date_commande', 'status', 'priority', 'items_count']
const TO_HIDE = ['company_name', 'date_commande', 'status']
const KEPT = ['order_number', 'priority', 'items_count']

let browser, ctx, page, token, pillId

async function login() {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  token = await page.evaluate(() => localStorage.getItem('erp_token'))
  assert.ok(token, 'token JWT introuvable après login')
}

async function apiFetch(path, init = {}) {
  const res = await ctx.request.fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  return res
}

function headerLabels() {
  return page.$$eval('[data-testid^="col-header-"]', els =>
    els.map(el => el.getAttribute('data-testid').replace('col-header-', ''))
  )
}

describe('DataTable — masquage de plusieurs colonnes en lot', () => {
  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await login()

    const res = await apiFetch('/views/orders/pills', {
      method: 'POST',
      data: {
        label: 'E2E colonnes lot',
        color: 'gray',
        filters: [],
        sort_order: 9999,
        visible_columns: PILL_COLS,
        sort: [],
      },
    })
    assert.equal(res.status(), 201, `création de la vue jetable échouée: ${await res.text()}`)
    pillId = (await res.json()).id
    assert.ok(pillId)
  })

  after(async () => {
    if (pillId && token) {
      const res = await apiFetch(`/views/orders/pills/${pillId}`, { method: 'DELETE' })
      if (!res.ok()) console.error('nettoyage: suppression de la vue jetable échouée', res.status())
    }
    await browser?.close()
  })

  test('⌘/Ctrl+clic sélectionne plusieurs en-têtes et une seule action les cache', async () => {
    // Sélectionne la vue jetable avant le premier rendu de /orders.
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.evaluate(id => localStorage.setItem('erp_lastView_orders', id), pillId)
    await page.reload({ waitUntil: 'networkidle' })

    await page.locator('[data-testid="col-header-status"]').waitFor({ state: 'visible', timeout: 20000 })
    const before = await headerLabels()
    for (const id of [...TO_HIDE, ...KEPT]) {
      assert.ok(before.includes(id), `colonne ${id} absente au départ (colonnes: ${before.join(', ')})`)
    }

    // Aucune barre de sélection tant qu'aucune colonne n'est sélectionnée.
    assert.equal(await page.locator('[data-testid="datatable-colsel-bar"]').count(), 0)

    for (const id of TO_HIDE) {
      await page.click(`[data-testid="col-header-${id}"]`, { modifiers: ['Control'] })
    }

    const bar = page.locator('[data-testid="datatable-colsel-bar"]')
    await bar.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await bar.innerText(), /3 colonnes sélectionnées/)
    for (const id of TO_HIDE) {
      assert.equal(
        await page.getAttribute(`[data-testid="col-header-${id}"]`, 'data-col-selected'),
        'true',
        `l'en-tête ${id} devrait être surligné comme sélectionné`
      )
    }
    assert.equal(await page.getAttribute('[data-testid="col-header-priority"]', 'data-col-selected'), null)

    await page.click('[data-testid="colsel-hide"]')

    await page.locator('[data-testid="col-header-status"]').waitFor({ state: 'detached', timeout: 5000 })
    const after = await headerLabels()
    for (const id of TO_HIDE) {
      assert.ok(!after.includes(id), `colonne ${id} toujours visible après masquage en lot`)
    }
    for (const id of KEPT) {
      assert.ok(after.includes(id), `colonne ${id} ne devait pas être masquée (colonnes: ${after.join(', ')})`)
    }
    assert.equal(await page.locator('[data-testid="datatable-colsel-bar"]').count(), 0, 'la barre de sélection devait disparaître')

    // Le masquage en lot est persisté sur la vue (un seul autosave).
    await page.waitForTimeout(1500)
    const res = await apiFetch('/views/orders')
    const { pills } = await res.json()
    const pill = pills.find(p => p.id === pillId)
    assert.ok(pill, 'vue jetable introuvable côté serveur')
    for (const id of TO_HIDE) {
      assert.ok(!pill.visible_columns.includes(id), `colonne ${id} encore dans la vue persistée: ${pill.visible_columns.join(', ')}`)
    }
    for (const id of KEPT) {
      assert.ok(pill.visible_columns.includes(id), `colonne ${id} disparue de la vue persistée`)
    }
  })

  test('Maj+clic sélectionne une plage et le clic droit propose de cacher le lot', async () => {
    // Repart d'une vue jetable propre (colonnes rétablies par API).
    const put = await apiFetch(`/views/orders/pills/${pillId}`, {
      method: 'PUT',
      data: { visible_columns: PILL_COLS, filters: [], sort: [], group_by: null, group_order: null },
    })
    assert.ok(put.ok(), `restauration des colonnes échouée: ${await put.text()}`)

    await page.goto(URL + '/orders', { waitUntil: 'networkidle' })
    await page.locator('[data-testid="col-header-status"]').waitFor({ state: 'visible', timeout: 20000 })

    await page.click('[data-testid="col-header-company_name"]', { modifiers: ['Control'] })
    await page.click('[data-testid="col-header-status"]', { modifiers: ['Shift'] })

    const bar = page.locator('[data-testid="datatable-colsel-bar"]')
    await bar.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await bar.innerText(), /3 colonnes sélectionnées/, 'Maj+clic devrait sélectionner la plage entière')

    await page.click('[data-testid="col-header-date_commande"]', { button: 'right' })
    const item = page.locator('[data-testid="colmenu-hide-selected"]')
    await item.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await item.innerText(), /Cacher les 3 colonnes sélectionnées/)
    await item.click()

    await page.locator('[data-testid="col-header-status"]').waitFor({ state: 'detached', timeout: 5000 })
    const after = await headerLabels()
    for (const id of TO_HIDE) assert.ok(!after.includes(id), `colonne ${id} toujours visible`)
    for (const id of KEPT) assert.ok(after.includes(id), `colonne ${id} ne devait pas être masquée`)
  })
})
