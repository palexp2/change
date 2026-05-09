// Smoke test: an order whose company has at least one operational
// central_controller renders the Orisha link in the OrderDetail header.

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

describe('OrderDetail — affichage des contrôleurs centraux du client', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('un order dont le client a un contrôleur opérationnel affiche le lien Orisha', async () => {
    // Find an order whose company has at least one operational central_controller.
    // Walk a recent slice of orders and pick the first match.
    const orderId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=50', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        if (Array.isArray(detail.central_controllers) && detail.central_controllers.length > 0) {
          return o.id
        }
      }
      return null
    })

    assert.ok(orderId, 'aucune commande trouvée avec un central_controller opérationnel — élargir le scan ou créer une fixture')

    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // The header sub-line should contain at least one link to app.orisha.io/#admin/.
    const link = page.locator('a[href^="https://app.orisha.io/#admin/"]').first()
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const href = await link.getAttribute('href')
    assert.match(href, /^https:\/\/app\.orisha\.io\/#admin\/.+/)
  })
})
