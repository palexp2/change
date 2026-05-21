// OrderDetail / Modale Novoxpress :
//   - le champ "Poids total (lbs)" est pré-rempli avec la somme de
//     (weight_lbs × qty) pour les seuls items dont shipment_id === id de l'envoi
//     courant (pas tous les order_items de la commande).
//   - si la somme vaut 0 (aucun poids configuré sur les produits), le champ
//     se pré-remplit avec 1 par défaut.
//
// Le test mocke l'endpoint /api/shipments/:id pour contrôler exactement les
// items renvoyés, donc il ne touche pas la DB.

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

describe('Novoxpress modal — poids total par défaut basé sur items du shipment', () => {
  let browser, ctx, page
  let orderId, shipmentId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const status = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/novoxpress/status', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    if (!status?.configured) throw new Error('Novoxpress non configuré — test skip')

    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=200', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
        const sh = (detail.shipments || [])[0]
        if (sh) return { orderId: o.id, shipmentId: sh.id }
      }
      return null
    })
    assert.ok(found, 'aucune commande avec ≥1 shipment trouvée')
    orderId = found.orderId
    shipmentId = found.shipmentId
  })

  after(async () => {
    await browser?.close()
  })

  async function openModalWithMock(items) {
    await page.route(`**/api/shipments/${shipmentId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: shipmentId,
          order_id: orderId,
          order_number: 'TEST',
          company_id: null,
          company_name: 'Test Co',
          address_country: 'CA',
          order_items: items,
        }),
      })
    })

    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })

    const novoBtn = page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first()
    await novoBtn.click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
  }

  async function closeModal() {
    await page.getByRole('button', { name: /^Annuler$/ }).click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'hidden', timeout: 5000 })
    await page.unroute(`**/api/shipments/${shipmentId}`)
  }

  test('somme uniquement les items dont shipment_id correspond à l\'envoi courant', async () => {
    // 2 items dans cet envoi (2×3 + 1.5×2 = 9), 1 item dans un autre envoi (ignoré).
    await openModalWithMock([
      { id: 'a', shipment_id: shipmentId, weight_lbs: 2,    qty: 3, product_name: 'A' },
      { id: 'b', shipment_id: shipmentId, weight_lbs: 1.5,  qty: 2, product_name: 'B' },
      { id: 'c', shipment_id: 'other-shipment', weight_lbs: 10, qty: 1, product_name: 'C' },
    ])

    const weightInput = page.locator('label:has-text("Poids total") + input').first()
    await weightInput.waitFor({ state: 'visible', timeout: 5000 })
    const val = await weightInput.inputValue()
    assert.equal(val, '9.00', `poids devrait être 9.00 (2×3 + 1.5×2, item d'un autre envoi ignoré) — reçu: ${val}`)

    await closeModal()
  })

  test('défaut à 1 quand aucun item du shipment n\'a de poids', async () => {
    await openModalWithMock([
      { id: 'a', shipment_id: shipmentId, weight_lbs: null, qty: 3, product_name: 'A' },
      { id: 'b', shipment_id: shipmentId, weight_lbs: 0,    qty: 2, product_name: 'B' },
      { id: 'c', shipment_id: 'other-shipment', weight_lbs: 10, qty: 1, product_name: 'C' },
    ])

    const weightInput = page.locator('label:has-text("Poids total") + input').first()
    await weightInput.waitFor({ state: 'visible', timeout: 5000 })
    const val = await weightInput.inputValue()
    assert.equal(val, '1', `poids devrait défaut à 1 quand somme=0 — reçu: ${val}`)

    await closeModal()
  })

  test('défaut à 1 quand le shipment n\'a aucun item assigné', async () => {
    await openModalWithMock([
      { id: 'c', shipment_id: 'other-shipment', weight_lbs: 10, qty: 1, product_name: 'C' },
    ])

    const weightInput = page.locator('label:has-text("Poids total") + input').first()
    await weightInput.waitFor({ state: 'visible', timeout: 5000 })
    const val = await weightInput.inputValue()
    assert.equal(val, '1', `poids devrait défaut à 1 quand aucun item — reçu: ${val}`)

    await closeModal()
  })
})
