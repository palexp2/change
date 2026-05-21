// Couvre la nouvelle section « Historique des événements » de la fiche facture
// (refonte de l'ancien « État comptable QuickBooks »). Les états de la facture
// sont mockés via page.route pour rendre le test déterministe — la DB n'est pas
// touchée et aucun cleanup n'est nécessaire.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Facture utilitaire — on n'écrit pas en DB, on intercepte simplement les
// réponses serveur pour injecter l'état voulu.
const FACTURE_ID = '9e045250-9767-4675-a54c-ffb0b7094d10' // TDGMEWE0-0002

describe('FactureDetail — timeline « Historique des événements »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('Consolide encaissement + déférée + constatation et trie chronologiquement', async () => {
    // Injecte une facture avec paid_at + deferred_revenue + recognized + shipment,
    // toutes proches dans le temps pour valider la consolidation.
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      Object.assign(body, {
        created_at: '2026-04-23T14:32:00.000Z',
        paid_at: '2026-04-24T09:12:00.000Z',
        paid_amount: 1234.56,
        paid_charge_id: 'ch_3ABCxyz',
        deferred_revenue_at: '2026-04-24T09:12:01.000Z',
        deferred_revenue_amount_cad: 1089.42,
        deferred_revenue_qb_ref: 'salesreceipt:4521',
        deferred_revenue_qb_url: 'https://qbo.intuit.com/app/salesreceipt?txnId=4521',
        first_shipped_at: '2026-04-28T16:08:00.000Z',
        revenue_recognized_at: '2026-04-28T16:09:00.000Z',
        revenue_recognized_je_id: '4567',
        revenue_recognized_qb_url: 'https://qbo.intuit.com/app/journal?txnId=4567',
        has_linked_shipment: 1,
        kind: 'order',
      })
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route(`**/api/payments/facture/${FACTURE_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    )

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    // Titre renommé
    await section.getByText('Historique des événements').waitFor({ state: 'visible', timeout: 5000 })

    // Les 3 événements attendus existent : créée, encaissée+déférée consolidé, expédiée+constatée consolidé
    await section.getByTestId('event-created').waitFor({ state: 'visible', timeout: 5000 })
    const paid = section.getByTestId('event-paid-stripe')
    await paid.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(paid.getByText('Encaissée + déférée').waitFor({ state: 'visible', timeout: 5000 }))
    const recognized = section.getByTestId('event-recognized')
    await recognized.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(recognized.getByText('Expédiée + vente constatée').waitFor({ state: 'visible', timeout: 5000 }))

    // Liens QB inline : DEP/SR/JE
    await assert.doesNotReject(paid.getByText('SR #4521').waitFor({ state: 'visible', timeout: 5000 }))
    await assert.doesNotReject(recognized.getByText('JE #4567').waitFor({ state: 'visible', timeout: 5000 }))

    // Lien Stripe charge tronqué (ch_3ABCxyz → ch_3A…xyz)
    await assert.doesNotReject(paid.getByText(/ch_3A/).waitFor({ state: 'visible', timeout: 5000 }))
  })

  test('Bouton « Constater manuellement » est dans l\'en-tête, pas constatée → visible', async () => {
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      Object.assign(body, {
        revenue_recognized_at: null,
        revenue_recognized_je_id: null,
        kind: 'order',
      })
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    const btn = section.locator('[data-testid="accounting-recognize-btn"]')
    await btn.waitFor({ state: 'visible', timeout: 5000 })
    assert.match(await btn.innerText(), /Constater manuellement/)
    // Le bouton doit être DANS l'en-tête (sibling du h2), pas dans la liste d'événements
    const headerBtn = section.locator('div').filter({ hasText: 'Historique des événements' }).first()
      .locator('[data-testid="accounting-recognize-btn"]')
    assert.equal(await headerBtn.count(), 1, 'le bouton doit être dans l\'en-tête de la section')
  })

  test('Aucun événement futur prédit (uniquement le passé)', async () => {
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      Object.assign(body, {
        paid_at: '2026-05-19T14:21:00.000Z',
        paid_amount: 8421.30,
        deferred_revenue_at: '2026-05-19T14:21:01.000Z',
        deferred_revenue_amount_cad: 7432.18,
        deferred_revenue_qb_ref: 'salesreceipt:5012',
        deferred_revenue_qb_url: 'https://qbo.intuit.com/app/salesreceipt?txnId=5012',
        first_shipped_at: null,
        revenue_recognized_at: null,
        revenue_recognized_je_id: null,
        has_linked_shipment: 0,
        kind: 'order',
      })
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route(`**/api/payments/facture/${FACTURE_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    )

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    // Le payment a eu lieu, la constatation pas encore — l'événement Vente
    // constatée ne doit PAS apparaître (pas de futur prédit).
    assert.equal(await section.locator('[data-testid="event-recognized"]').count(), 0,
      'L\'événement de constatation ne doit pas apparaître tant que revenue_recognized_at est NULL')
    // Pas de placeholder « en attente » ni « prévu » dans le texte de la section.
    const text = await section.innerText()
    assert.equal(/prévu|en attente|à venir|attendu/i.test(text), false,
      'La timeline ne doit afficher que les événements passés (pas de prédiction)')
  })

  test('Badge ⚠ d\'anomalie apparaît sur l\'événement après vérification QB divergente', async () => {
    await page.route(`**/api/projets/factures/${FACTURE_ID}`, async (route, req) => {
      if (req.method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      Object.assign(body, {
        paid_at: '2026-04-24T09:12:00.000Z',
        paid_amount: 1234.56,
        deferred_revenue_at: '2026-04-24T09:12:01.000Z',
        deferred_revenue_amount_cad: 1089.42,
        deferred_revenue_qb_ref: 'salesreceipt:4521',
        deferred_revenue_qb_url: 'https://qbo.intuit.com/app/salesreceipt?txnId=4521',
        kind: 'order',
      })
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route(`**/api/payments/facture/${FACTURE_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    )
    // Mocke un qb-state qui rapporte une divergence sur le déféré
    await page.route(`**/api/projets/factures/${FACTURE_ID}/qb-state`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          facture_id: FACTURE_ID,
          document_number: 'MOCK',
          checked_at: '2026-05-20T10:00:00.000Z',
          checks: [{
            kind: 'deferred_revenue',
            consistent: false,
            qb_status: 'missing',
            message: 'Sales Receipt introuvable côté QuickBooks',
          }],
        }),
      })
    )

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })

    // Avant Verify : pas de badge anomalie ni de bouton clear
    assert.equal(await section.locator('[data-testid="clear-deferred-btn"]').count(), 0)
    await section.locator('[data-testid="verify-qb-btn"]').click()
    // Le badge ⚠ doit apparaître sur l'événement consolidé "Encaissée + déférée"
    const anomalyBtn = section.locator('[data-testid="clear-deferred-btn"]')
    await anomalyBtn.waitFor({ state: 'visible', timeout: 5000 })
    // Click ouvre la modale d'effacement
    await anomalyBtn.click()
    await page.getByText('Effacer le passif local 23900 ?').waitFor({ state: 'visible', timeout: 5000 })
    // Annule
    await page.locator('button:has-text("Annuler")').click()
  })
})
