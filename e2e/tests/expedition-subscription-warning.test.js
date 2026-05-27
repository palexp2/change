// Mode expédition / avertissement abonnement :
//   sur la fiche commande en mode expédition, si la commande est marquée
//   comme abonnement (is_subscription=1), un banner d'avertissement doit
//   s'afficher en haut de la view, demandant au prélecteur de prendre les
//   produits reconditionnés en priorité. Le banner doit être absent quand
//   is_subscription=0.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('Mode expédition — warning "produits reconditionnés" pour abonnements', () => {
  let browser, ctx, page
  let companyId, subOrderId, normalOrderId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const co = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E SubWarning ${Date.now()}` }),
    })
    assert.ok(co.status === 200 || co.status === 201, `company create: ${co.status}`)
    companyId = co.body.id

    const sub = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, status: 'En cours', is_subscription: 1, notes: 'E2E sub-warning (abonnement)' }),
    })
    assert.ok(sub.status === 200 || sub.status === 201, `sub order create: ${sub.status}`)
    subOrderId = sub.body.id

    const normal = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, status: 'En cours', is_subscription: 0, notes: 'E2E sub-warning (achat)' }),
    })
    assert.ok(normal.status === 200 || normal.status === 201, `normal order create: ${normal.status}`)
    normalOrderId = normal.body.id
  })

  after(async () => {
    if (subOrderId)    try { await apiFetch(page, `/api/orders/${subOrderId}`,    { method: 'DELETE' }) } catch {}
    if (normalOrderId) try { await apiFetch(page, `/api/orders/${normalOrderId}`, { method: 'DELETE' }) } catch {}
    if (companyId)     try { await apiFetch(page, `/api/companies/${companyId}`,  { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('warning visible en mode expédition quand is_subscription=1', async () => {
    await page.goto(`${URL}/orders/${subOrderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    const warning = page.locator('text=/Prendre les produits reconditionnés si possible/i')
    await warning.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('warning absent en mode expédition quand is_subscription=0', async () => {
    await page.goto(`${URL}/orders/${normalOrderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    const warning = page.locator('text=/Prendre les produits reconditionnés si possible/i')
    assert.equal(await warning.count(), 0, 'warning ne devrait pas être visible pour un achat normal')
  })
})
