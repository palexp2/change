// Fiche envoi — bouton dédié "Commander un ramassage" :
//   - le bouton apparaît quand l'envoi a un novoxpress_shipment_id (étiquette
//     achetée) et pas encore de novoxpress_pickup_id
//   - cliquer ouvre une modale qui affiche la note de ramassage + le formulaire
//   - confirmer appelle POST /api/novoxpress/pickup/:shipmentId
//
// La modale et l'appel pickup sont mockés côté navigateur pour ne pas facturer
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

describe('Fiche envoi — commander un ramassage (bouton dédié)', () => {
  let browser, ctx, page
  let shipmentId, orderId

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

  // Mock la fiche envoi : étiquette achetée (novoxpress_shipment_id) mais pas
  // encore de ramassage (novoxpress_pickup_id null) → le bouton doit apparaître.
  function installMocks(captureRefs, { hasPickup = false } = {}) {
    return Promise.all([
      page.route(`**/api/shipments/${shipmentId}`, async route => {
        if (route.request().method() !== 'GET') return route.continue()
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            id: shipmentId, order_id: orderId, order_number: 'TEST',
            company_name: 'Test Co', address_id: 'addr-1', address_country: 'CA',
            address_line1: '123 rue Test', status: 'Envoyé',
            tracking_number: 'TRK-XYZ', carrier: 'Purolator',
            label_pdf_path: `${shipmentId}.pdf`,
            novoxpress_shipment_id: 'NX-123',
            novoxpress_pickup_id: hasPickup ? 'PU-999' : null,
            order_items: [{ id: 'x', shipment_id: shipmentId, weight_lbs: 2, qty: 1, product_name: 'X' }],
          }),
        })
      }),
      page.route(`**/api/novoxpress/pickup/${shipmentId}`, async route => {
        if (route.request().method() !== 'POST') return route.continue()
        try { captureRefs.pickupPayload = JSON.parse(route.request().postData() || '{}') } catch {}
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ pickup_id: 'PU-456', message: 'OK' }),
        })
      }),
    ])
  }

  function uninstallMocks() {
    return Promise.all([
      page.unroute(`**/api/shipments/${shipmentId}`),
      page.unroute(`**/api/novoxpress/pickup/${shipmentId}`),
    ])
  }

  test('le bouton "Commander un ramassage" est visible quand l\'étiquette est achetée', async () => {
    const refs = {}
    await installMocks(refs, { hasPickup: false })
    await page.goto(`${URL}/envois/${shipmentId}`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: /Commander un ramassage/ }).waitFor({ state: 'visible', timeout: 5000 })
    await uninstallMocks()
  })

  test('le bouton disparaît quand un ramassage est déjà planifié', async () => {
    const refs = {}
    await installMocks(refs, { hasPickup: true })
    await page.goto(`${URL}/envois/${shipmentId}`, { waitUntil: 'networkidle' })

    // Le badge "Planifié" doit être là, mais pas le bouton de commande.
    await page.locator('text=/Planifié ·/').first().waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await page.getByRole('button', { name: /Commander un ramassage/ }).count(), 0,
      'le bouton ne devrait pas apparaître si un ramassage existe déjà')
    await uninstallMocks()
  })

  test('cliquer ouvre la modale avec la note de ramassage et confirmer appelle /pickup', async () => {
    const refs = {}
    await installMocks(refs, { hasPickup: false })
    await page.goto(`${URL}/envois/${shipmentId}`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: /Commander un ramassage/ }).click()

    // La modale s'ouvre avec la note de ramassage (déplacée ici).
    await page.locator('text=Commander un ramassage').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=/coursier.*récupérer le colis/i').first().waitFor({ state: 'visible', timeout: 3000 })

    await page.getByRole('button', { name: /Confirmer le ramassage/ }).click()

    // Écran de succès + appel pickup capturé.
    await page.locator('text=Ramassage planifié').first().waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(refs.pickupPayload, 'pickup endpoint devrait avoir été appelé')
    assert.ok(refs.pickupPayload.date?.year, 'pickup payload devrait avoir une date')
    assert.ok(refs.pickupPayload.ready_at?.hour != null, 'pickup payload devrait avoir ready_at')

    await page.locator('button:has-text("Fermer")').first().click()
    await uninstallMocks()
  })
})
