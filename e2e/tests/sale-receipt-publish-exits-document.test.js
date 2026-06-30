const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que publier un document sur QuickBooks DEPUIS la fiche détail sort du
// document et renvoie vers l'interface Extraction de données (liste).
//
// IMPORTANT : publier réellement créerait un enregistrement dans QuickBooks
// (vrai side effect externe). On intercepte donc l'appel `push-to-qb` (réponse
// mockée 200) et on injecte un quickbooks_id dans la relecture post-publication
// — le formulaire et ses comptes restent chargés depuis le vrai connecteur QB,
// seule l'écriture distante est court-circuitée. Aucune donnée QB n'est créée,
// aucune mutation DB persistée.

describe('Extraction de données : publier QB depuis un document renvoie à la liste', () => {
  let browser, ctx, page
  let token, receiptId
  let originalQbId, originalQbType, nulledForTest

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    // Idéalement un reçu done non publié ; sinon on en dé-publie un temporairement.
    let candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id)
    if (!candidate) {
      candidate = body.data.find(r => r.status === 'done' && r.quickbooks_id)
      assert.ok(candidate, 'Préalable : au moins un reçu status=done requis')
      originalQbId = candidate.quickbooks_id
      originalQbType = candidate.quickbooks_type
      nulledForTest = true
      await page.request.patch(URL + '/api/sale-receipts/' + candidate.id, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { quickbooks_id: null, quickbooks_type: null },
      })
    }
    receiptId = candidate.id
  })

  after(async () => {
    // Restaure le quickbooks_id d'origine si on l'avait nullé pour le test.
    if (nulledForTest && receiptId) {
      await page.request.patch(URL + '/api/sale-receipts/' + receiptId, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        data: { quickbooks_id: originalQbId, quickbooks_type: originalQbType },
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('publier sur QuickBooks renvoie sur /sale-receipts', async () => {
    let published = false

    // Court-circuite l'écriture QB réelle.
    await page.route(`**/api/sale-receipts/${receiptId}/push-to-qb`, async route => {
      published = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    // La relecture post-publication renvoie le reçu marqué publié.
    await page.route(`**/api/sale-receipts/${receiptId}`, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const json = await response.json()
      if (published) {
        json.quickbooks_id = 'E2E-MOCK'
        json.quickbooks_type = 'purchase'
        json.status = 'published'
      }
      await route.fulfill({ response, json })
    })

    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 20000 })

    // Fournisseur : mode « Nouveau » pour ne pas dépendre d'un vendor existant.
    await page.getByText('Nouveau', { exact: true }).click()
    await page.fill('input[placeholder="Nom du fournisseur"]', 'E2E Vendor')

    // Compte de dépense : première option réelle du portail.
    await page.getByTestId('qb-expense-select').click()
    let portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('button').first().click()

    // Compte de paiement (mode purchase) : première option réelle.
    await page.getByTestId('qb-payment-select').click()
    portal = page.locator('#qb-select-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('button').first().click()

    // Publier
    await page.getByRole('button', { name: /Publier sur QuickBooks/ }).click()

    // On doit sortir du document et revenir à la liste.
    await page.waitForFunction(() => /\/sale-receipts$/.test(location.pathname), null, { timeout: 10000 })
    assert.match(page.url(), /\/sale-receipts$/, `retour à la liste attendu, vu : ${page.url()}`)
    assert.ok(published, 'l\'appel push-to-qb doit avoir été déclenché')
  })
})
