// Novoxpress — achat d'étiquette OK mais téléchargement du PDF en échec (403 CDN).
//
// Régression du scénario réel : create-shipment réussit (compte facturé) mais le
// fetch du PDF renvoie 403. Avant, la modale affichait une erreur générique et la
// vente était perdue. Maintenant le backend renvoie { purchased:true, label_url:null,
// label_error } et la modale doit :
//   - confirmer que l'ACHAT a réussi (pas un échec total)
//   - expliquer pourquoi le PDF n'est pas dispo (label_error)
//   - offrir « Réessayer le téléchargement » (route retry-pdf, sans re-facturer)
//
// Tous les endpoints Novoxpress sont mockés côté navigateur — aucune facturation prod.

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

describe('Novoxpress — récupération du PDF après achat réussi (403 téléchargement)', () => {
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

  async function installMocks(refs) {
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
    await page.route(`**/api/novoxpress/rates/${shipmentId}`, async route => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'req-test',
          rates: [{ service_id: 'PURO-GROUND', service_name: 'Ground', carrier_name: 'Purolator', total: { value: '15.00', currency: 'CAD' } }],
        }),
      })
    })
    // label — achat OK mais PDF non téléchargé (403)
    await page.route(`**/api/novoxpress/label/${shipmentId}`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      refs.labelCalled = true
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          purchased: true,
          shipment_id: 'NX-123',
          tracking_id: 'TRK-XYZ',
          label_url: null,
          label_error: 'Novoxpress: échec téléchargement étiquette (403)',
        }),
      })
    })
    // retry-pdf — récupération réussie du PDF
    await page.route(`**/api/novoxpress/label/${shipmentId}/retry-pdf`, async route => {
      refs.retryCalled = true
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ label_url: '/erp/api/novoxpress/labels/test.pdf', tracking_id: 'TRK-XYZ' }),
      })
    })
  }

  async function uninstallMocks() {
    await page.unroute(`**/api/shipments/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/rates/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/label/${shipmentId}`)
    await page.unroute(`**/api/novoxpress/label/${shipmentId}/retry-pdf`)
  }

  async function buyLabel() {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first().click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    await page.locator('button', { hasText: /Ground/ }).first().click()
    await page.locator('text=Récapitulatif').waitFor({ state: 'visible', timeout: 5000 })
    await page.getByRole('button', { name: /Confirmer et acheter/ }).click()
  }

  test('PDF en échec → l\'achat est confirmé et le téléchargement peut être réessayé', async () => {
    const refs = {}
    await installMocks(refs)
    await buyLabel()

    // État partiel : achat confirmé, PDF manquant
    await page.locator('text=/Étiquette achetée/i').first().waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(refs.labelCalled, 'label endpoint appelé')

    // Le message confirme explicitement que l'achat a réussi (≠ erreur générique)
    await page.locator('text=/L.achat de l.étiquette a bien été effectué/i').first().waitFor({ state: 'visible', timeout: 3000 })
    // La raison du blocage (label_error) est affichée
    assert.ok(await page.locator('text=/403/').count() > 0, 'la raison 403 doit être affichée')
    // Le n° de suivi reste disponible malgré l'échec PDF
    assert.ok(await page.locator('text=TRK-XYZ').count() > 0, 'tracking affiché')
    // Pas de lien de téléchargement direct (pas de PDF)
    assert.equal(await page.locator('a:has-text("Télécharger l\'étiquette PDF")').count(), 0, 'pas de lien PDF tant que non récupéré')

    // Réessayer le téléchargement
    await page.getByRole('button', { name: /Réessayer le téléchargement/ }).click()

    // Succès → bascule vers l'état « étiquette créée » avec lien de téléchargement
    await page.locator('text=Étiquette créée').first().waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('a:has-text("Télécharger l\'étiquette PDF")').first().waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(refs.retryCalled, 'retry-pdf endpoint appelé')

    await page.locator('button:has-text("Fermer")').first().click()
    await uninstallMocks()
  })
})
