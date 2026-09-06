// Vérifie que les pages pilotes (Products + Contacts) lisent depuis le store
// global (dataStore) et non plus depuis api.x.list().
//
// Heuristique : on intercepte les fetchs réseau et on vérifie qu'aucun GET vers
// /erp/api/products?page=… ni /erp/api/contacts?page=… n'est émis quand on
// navigue sur ces pages — le store doit les servir directement après bootstrap.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`Login failed: ${r.status}`)
  const { token } = await r.json()
  return token
}

describe('Pages pilotes — lecture depuis le dataStore', () => {
  let token, browser, ctx, page

  before(async () => {
    token = await login()
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.addInitScript((t) => localStorage.setItem('erp_token', t), token)
    // Dashboard charge le bootstrap initial.
    await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' })
    // Attend que le store soit hydraté pour products + contacts.
    await page.waitForFunction(() => {
      if (typeof window.__erpStore !== 'function') return false
      const s = window.__erpStore()
      return (s.tables.products?.rows || 0) > 0 && (s.tables.contacts?.rows || 0) > 0
    }, { timeout: 60000 })
  })

  after(async () => { await browser?.close() })

  test('Products affiche des lignes sans appeler /api/products?page=', async () => {
    const requests = []
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/erp/api/products') && req.method() === 'GET') requests.push(url)
    })

    await page.goto(`${URL}/products`, { waitUntil: 'domcontentloaded' })
    // Attend qu'une ligne du tableau apparaisse (le rendu peut prendre quelques ms).
    await page.waitForSelector('[data-row-id]', { timeout: 10000 })

    // Aucun GET /erp/api/products avec pagination (que le store remplacerait).
    const paginated = requests.filter(u => u.includes('page=') || u.includes('limit='))
    assert.equal(paginated.length, 0, `Aucun fetch /api/products paginated attendu, vu: ${paginated.join(', ')}`)

    const rowCount = await page.locator('[data-row-id]').count()
    assert.ok(rowCount > 0, 'Le tableau Products doit avoir au moins une ligne (rendue depuis le store)')
  })

  test('Contacts affiche des lignes sans appeler /api/contacts?page=', async () => {
    const requests = []
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/erp/api/contacts') && req.method() === 'GET') requests.push(url)
    })

    await page.goto(`${URL}/contacts`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-row-id]', { timeout: 10000 })

    const paginated = requests.filter(u => u.includes('page=') || u.includes('limit='))
    assert.equal(paginated.length, 0, `Aucun fetch /api/contacts paginated attendu, vu: ${paginated.join(', ')}`)

    const rowCount = await page.locator('[data-row-id]').count()
    assert.ok(rowCount > 0, 'Le tableau Contacts doit avoir au moins une ligne (rendue depuis le store)')
  })
})
