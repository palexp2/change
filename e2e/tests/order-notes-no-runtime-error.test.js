// Régression : taper dans le textarea Notes de OrderDetail (avec Enter)
// déclenchait "TypeError: items.map is not a function" parce que le payload
// realtime `order:updated` venait écraser le tableau `items` du détail par
// la colonne legacy Airtable `items` (TEXT JSON d'IDs `recXXX`). Le handler
// realtime strippe désormais cette colonne au merge — on garde un test
// permanent pour empêcher la réintroduction.

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

describe('OrderDetail — Notes ne déclenche pas d\'exception au save realtime', () => {
  let browser, ctx, page, orderId, original
  const pageErrors = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    page.on('pageerror', err => pageErrors.push(err))
    await login(page)
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=1', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      const o = (list.data || [])[0]
      const detail = await fetch(`/erp/api/orders/${o.id}`, {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      return { id: o.id, notes: detail.notes || '' }
    })
    orderId = data.id
    original = data.notes
  })

  after(async () => {
    if (orderId) {
      try {
        await page.evaluate(async ({ id, notes }) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/orders/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes }),
          })
        }, { id: orderId, notes: original })
      } catch {}
    }
    await browser?.close()
  })

  test('Enter + texte dans le textarea Notes ne produit aucune exception', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    const textarea = page.locator('textarea[placeholder="Ajouter des notes…"]')
    await textarea.waitFor({ state: 'visible' })
    await textarea.focus()
    await page.keyboard.type('avant-enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('apres-enter')
    // Laisse le temps au debounce, à la PUT et à l'event realtime de tourner.
    await page.waitForTimeout(1500)

    if (pageErrors.length) {
      for (const e of pageErrors) console.log(e.stack || e.message)
    }
    assert.equal(pageErrors.length, 0, `${pageErrors.length} exception(s) page capturée(s)`)
  })
})
