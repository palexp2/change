// Realtime collab on the order detail page (`/orders/:id`).
// Both contexts open the same order. B adds + deletes items via API. A must
// see the item appear and disappear without refresh.

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

describe('Realtime — items de commande sur /orders/:id', () => {
  let browser, ctxA, ctxB, pageA, pageB
  let orderId = null
  let createdItemId = null

  before(async () => {
    browser = await chromium.launch()
    ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    pageA = await ctxA.newPage()
    pageB = await ctxB.newPage()
    await login(pageA)
    await login(pageB)

    // Create a fresh order for the test and capture its id.
    const order = await pageB.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ status: 'Commande vide', notes: 'realtime-items-e2e' }),
      })
      return r.json()
    })
    if (!order?.id) throw new Error('order creation failed: ' + JSON.stringify(order))
    orderId = order.id
  })

  after(async () => {
    // Hard delete (?hard=true) — supprime la commande ET ses order_items pour ne
    // laisser aucun résidu en base (un simple DELETE ne fait qu'un soft-delete).
    // S'exécute même si le test a échoué.
    if (orderId) {
      try {
        await pageB.evaluate(async (id) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}?hard=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
        }, orderId)
      } catch {}
    }
    await browser?.close()
  })

  test('ajout item par B → A voit le compteur Articles passer à 1', async () => {
    await pageA.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(800) // WS auth + subscribe

    // Sanity: the order is empty, the badge says "Articles (0)".
    await pageA.locator('h2:has-text("Articles (0)")').waitFor({ state: 'visible', timeout: 3000 })

    const item = await pageB.evaluate(async ({ id }) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/orders/${id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ qty: 3, unit_cost: 0, item_type: 'Facturable' }),
      })
      return r.json()
    }, { id: orderId })

    assert.ok(item?.id, 'item creation failed: ' + JSON.stringify(item))
    createdItemId = item.id

    // The Articles heading must update without refresh.
    await pageA.locator('h2:has-text("Articles (1)")').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('suppression item par B → A voit Articles repasser à 0', async () => {
    if (!createdItemId) return

    await pageB.evaluate(async ({ orderId, itemId }) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/orders/${orderId}/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}` },
      })
    }, { orderId, itemId: createdItemId })

    await pageA.locator('h2:has-text("Articles (0)")').waitFor({ state: 'visible', timeout: 5000 })
    createdItemId = null
  })
})
