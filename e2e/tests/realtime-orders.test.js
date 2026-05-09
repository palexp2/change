// Realtime collaboration smoke test.
//
// Two browser contexts log in. A watches /orders. B creates an order via the
// HTTP API. The new row must appear in A's DataTable within 3s thanks to the
// WebSocket broadcast wired in routes/orders.js → emit('orders:list', ...).
//
// Also covers update + delete on the same listener.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Realtime — collab live sur /orders', () => {
  let browser, ctxA, ctxB, pageA, pageB
  /** @type {string|null} */ let createdId = null

  before(async () => {
    browser = await chromium.launch()
    ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    pageA = await ctxA.newPage()
    pageB = await ctxB.newPage()
    await login(pageA)
    await login(pageB)
  })

  after(async () => {
    if (createdId) {
      try {
        await pageB.evaluate(async (id) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
        }, createdId)
      } catch {}
    }
    await browser?.close()
  })

  test('création par B → apparaît live dans la table de A', async () => {
    // Open A's orders page and let it fully load.
    await pageA.goto(URL + '/orders', { waitUntil: 'networkidle' })
    // Wait for the WS to authenticate + subscribe to orders:list. The lib
    // sends `subscribe` on auth:success — give it a beat.
    await pageA.waitForTimeout(500)

    // Create an order via API from B.
    const order = await pageB.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ status: 'Commande vide', notes: 'realtime-e2e' }),
      })
      return r.json()
    })
    assert.ok(order?.id, 'creation failed: ' + JSON.stringify(order))
    createdId = order.id

    // The order_number should now be visible in A's table without reloading.
    // DataTable uses virtualization but renders the first rows; new orders are
    // prepended (created_at DESC).
    const numText = `#${order.order_number}`
    const locator = pageA.locator(`text="${numText}"`).first()
    await locator.waitFor({ state: 'visible', timeout: 3000 })
  })

  test('update par B → A voit le statut changer', async () => {
    if (!createdId) return // skip if previous failed
    // Update status via B.
    await pageB.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ priority: 'Urgent' }),
      })
    }, createdId)

    // The "Urgent" priority badge for that order should appear in A's row.
    // We can't pin it perfectly without a row testid, but the priority cell
    // renders the literal string. Wait for it to show up somewhere on the page.
    await pageA.waitForFunction(() => document.body.innerText.includes('Urgent'), null, { timeout: 3000 })
  })

  test('suppression par B → la ligne disparaît chez A', async () => {
    if (!createdId) return
    const numText = `#${(await pageB.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/orders/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const o = await r.json()
      return o.order_number
    }, createdId))}`

    await pageB.evaluate(async (id) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/orders/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
    }, createdId)

    // Row should disappear within a few seconds.
    await pageA.waitForFunction((needle) => !document.body.innerText.includes(needle), numText, { timeout: 3000 })
    createdId = null // avoid double-delete in after()
  })
})
