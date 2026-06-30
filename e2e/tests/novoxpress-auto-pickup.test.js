// Modale Novoxpress — découplage étiquette / ramassage :
//   - la case "Commander un ramassage automatiquement" n'existe plus
//   - l'achat de l'étiquette NE déclenche PLUS d'appel POST /pickup
//   - l'étape "done" ne propose plus de ramassage (déplacé sur la fiche envoi)
//
// Le ramassage se commande désormais via un bouton dédié sur la fiche de
// l'envoi (voir envois-detail-commander-ramassage.test.js).
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

describe('Novoxpress modal — étiquette découplée du ramassage', () => {
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
    // pickup — ne devrait PAS être appelé depuis le flux étiquette
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

  async function openModalAndGetToPackage() {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first().click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
  }

  test('plus de case "Commander un ramassage automatiquement" dans la modale', async () => {
    const refs = {}
    await installMocks(refs)
    await openModalAndGetToPackage()

    const checkboxCount = await page.locator('label:has-text("Commander un ramassage")').locator('input[type="checkbox"]').count()
    assert.equal(checkboxCount, 0, 'la case auto-pickup ne devrait plus exister')

    await page.getByRole('button', { name: /^Annuler$/ }).click()
    await uninstallMocks()
  })

  test('achat de l\'étiquette → aucun appel pickup, pas de ramassage proposé', async () => {
    const refs = {}
    await installMocks(refs)
    await openModalAndGetToPackage()

    // package → rates
    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    await page.locator('text=Ground').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Ground/ }).first().click()

    // confirm — la note doit indiquer que le ramassage se commande séparément
    await page.locator('text=Récapitulatif').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=/ramassage.*séparément/i').first().waitFor({ state: 'visible', timeout: 3000 })

    await page.getByRole('button', { name: /Confirmer et acheter/ }).click()

    // done — étiquette créée, AUCUNE mention "Ramassage planifié" ni "Planifier un ramassage ?"
    await page.locator('text=Étiquette créée').first().waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.locator('text=Ramassage planifié').count(), 0, 'pas de ramassage planifié dans le flux étiquette')
    assert.equal(await page.locator('text=Planifier un ramassage ?').count(), 0, 'plus de prompt de ramassage dans le flux étiquette')

    assert.ok(refs.labelCalled, 'label endpoint devrait avoir été appelé')
    assert.equal(refs.pickupPayload, undefined, 'pickup ne devrait PAS avoir été appelé depuis le flux étiquette')

    await page.locator('button:has-text("Fermer")').first().click()
    await uninstallMocks()
  })
})
