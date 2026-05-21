// Modale Novoxpress — case "Commander un ramassage automatiquement" :
//   - case présente, cochée par défaut
//   - quand cochée, l'achat de l'étiquette déclenche automatiquement un appel
//     POST /api/novoxpress/pickup/:shipmentId avec une fenêtre 9h–16h
//   - quand décochée, aucun appel pickup n'est fait
//
// Le test mocke /rates, /label et /pickup côté navigateur pour ne pas facturer
// la prod Novoxpress.

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

describe('Novoxpress modal — ramassage automatique à l\'achat', () => {
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

  async function installMocks(captureRefs) {
    // shipments/:id — items factices pour ne pas dépendre de la DB
    await page.route(`**/api/shipments/${shipmentId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: shipmentId, order_id: orderId, order_number: 'TEST',
          company_name: 'Test Co', address_country: 'CA',
          order_items: [{ id: 'x', shipment_id: shipmentId, weight_lbs: 2, qty: 1, product_name: 'X' }],
        }),
      })
    })
    // rates — 1 tarif Purolator factice
    await page.route(`**/api/novoxpress/rates/${shipmentId}`, async route => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'req-test',
          rates: [{ service_id: 'PURO-GROUND', service_name: 'Ground', carrier_name: 'Purolator', total: { value: '15.00', currency: 'CAD' } }],
        }),
      })
    })
    // label — succès
    await page.route(`**/api/novoxpress/label/${shipmentId}`, async route => {
      captureRefs.labelCalled = true
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ shipment_id: 'NX-123', tracking_id: 'TRK-XYZ', label_url: '/erp/api/novoxpress/labels/test.pdf' }),
      })
    })
    // pickup — capture le payload
    await page.route(`**/api/novoxpress/pickup/${shipmentId}`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      try { captureRefs.pickupPayload = JSON.parse(route.request().postData() || '{}') } catch {}
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ pickup_id: 'PU-456', message: 'OK' }),
      })
    })
  }

  async function uninstallMocks() {
    await page.unroute(`**/api/shipments/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/rates/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/label/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/pickup/${shipmentId}`)
  }

  async function openModalAndGetToConfirm() {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first().click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
  }

  test('case "Commander un ramassage" présente et cochée par défaut', async () => {
    const refs = {}
    await installMocks(refs)
    await openModalAndGetToConfirm()

    const checkbox = page.locator('label:has-text("Commander un ramassage")').locator('input[type="checkbox"]')
    await checkbox.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await checkbox.isChecked(), true, 'la case devrait être cochée par défaut')

    await page.getByRole('button', { name: /^Annuler$/ }).click()
    await uninstallMocks()
  })

  test('case cochée → ramassage planifié automatiquement à l\'achat', async () => {
    const refs = {}
    await installMocks(refs)
    await openModalAndGetToConfirm()

    // package → rates
    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    await page.locator('text=Ground').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Ground/ }).first().click()

    // confirm → achat
    await page.locator('text=Récapitulatif').waitFor({ state: 'visible', timeout: 5000 })
    // Le récap doit mentionner le ramassage Purolator
    await page.locator('text=/ramassage.*Purolator/i').first().waitFor({ state: 'visible', timeout: 3000 })

    await page.getByRole('button', { name: /Confirmer et acheter/ }).click()

    // done step
    await page.locator('text=Étiquette créée').first().waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('text=Ramassage planifié').first().waitFor({ state: 'visible', timeout: 5000 })

    assert.ok(refs.labelCalled, 'label endpoint devrait avoir été appelé')
    assert.ok(refs.pickupPayload, 'pickup endpoint devrait avoir été appelé')
    assert.ok(refs.pickupPayload.date?.year, 'pickup payload devrait avoir une date')
    assert.equal(refs.pickupPayload.ready_until?.hour, 16, 'ready_until devrait être 16h')
    assert.ok(refs.pickupPayload.ready_at?.hour >= 9, `ready_at hour devrait être ≥ 9 — reçu: ${refs.pickupPayload.ready_at?.hour}`)
    assert.ok(refs.pickupPayload.ready_at?.hour <= 16, `ready_at hour devrait être ≤ 16 — reçu: ${refs.pickupPayload.ready_at?.hour}`)

    await page.locator('button:has-text("Fermer")').first().click()
    await uninstallMocks()
  })

  test('case décochée → aucun ramassage planifié à l\'achat', async () => {
    const refs = {}
    await installMocks(refs)
    await openModalAndGetToConfirm()

    // Décoche la case
    const checkbox = page.locator('label:has-text("Commander un ramassage")').locator('input[type="checkbox"]')
    await checkbox.uncheck()

    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    await page.locator('button', { hasText: /Ground/ }).first().click()
    await page.locator('text=Récapitulatif').waitFor({ state: 'visible', timeout: 5000 })

    // Le récap NE doit PAS mentionner le ramassage automatique
    const hasAutoPickupNote = await page.locator('text=/ramassage.*Purolator/i').count()
    assert.equal(hasAutoPickupNote, 0, 'la mention de ramassage auto ne devrait pas apparaître quand décoché')

    await page.getByRole('button', { name: /Confirmer et acheter/ }).click()
    await page.locator('text=Étiquette créée').first().waitFor({ state: 'visible', timeout: 10000 })

    // Le bloc "Ramassage planifié" ne doit PAS apparaître ; l'ancien prompt manuel doit l'être.
    await page.locator('text=Planifier un ramassage ?').first().waitFor({ state: 'visible', timeout: 3000 })

    assert.ok(refs.labelCalled, 'label devrait avoir été appelé')
    assert.equal(refs.pickupPayload, undefined, 'pickup ne devrait PAS avoir été appelé')

    await page.locator('button:has-text("Non merci")').first().click()
    await uninstallMocks()
  })
})
