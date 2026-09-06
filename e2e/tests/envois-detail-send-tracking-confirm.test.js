// EnvoisDetail — envoi du courriel de suivi : vérifie la confirmation explicite
// du side effect + le toast d'annulation (barre 10 s).
//   1. "Envoyer le suivi" ouvre la modale, on saisit une adresse.
//   2. "Envoyer" ouvre une modale de CONFIRMATION listant l'adresse + le n° de suivi.
//   3. Confirmer fait apparaître le toast d'annulation ; l'appel /send-tracking
//      n'est déclenché qu'à la fin du compte à rebours.
//   4. "Annuler" dans le toast empêche tout appel /send-tracking.
//
// Cleanup : le test crée l'envoi lui-même ; le after() force un DELETE via API.

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

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('EnvoisDetail — confirmation + toast d\'annulation pour l\'envoi du suivi', () => {
  let browser, ctx, page
  let createdShipmentId = null
  let trackingNumber = `E2E-TRK-${Date.now()}`

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const list = await apiFetch(page, '/api/orders?limit=10')
    assert.equal(list.status, 200)
    assert.ok(list.body.data?.length, 'aucune commande disponible pour le test')
    const orderId = list.body.data[0].id

    const created = await apiFetch(page, '/api/shipments', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        tracking_number: trackingNumber,
        carrier: 'E2E Test',
        notes: 'E2E test shipment — send tracking confirm',
      }),
    })
    assert.ok(created.status === 200 || created.status === 201, `shipment create failed (${created.status})`)
    createdShipmentId = created.body.id
    assert.ok(createdShipmentId, 'shipment id missing')
  })

  after(async () => {
    if (createdShipmentId) {
      try { await apiFetch(page, `/api/shipments/${createdShipmentId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  // Ouvre la modale d'envoi du suivi et saisit l'adresse.
  async function openTrackingModal(email) {
    await page.goto(`${URL}/envois/${createdShipmentId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Envoyer le suivi/ }).click()
    await page.waitForSelector('text=Envoyer le courriel de suivi', { timeout: 5000 })
    const input = page.locator('[role="dialog"] input[type="email"]').first()
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.fill(email)
    return input
  }

  test('Envoyer → confirmation listant l\'adresse → toast 10 s → /send-tracking à la fin', async () => {
    await openTrackingModal('suivi-e2e@orisha.test')

    let sendCount = 0
    await page.route('**/api/shipments/*/send-tracking', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    // "Envoyer" → modale de confirmation listant l'adresse + le n° de suivi.
    await page.locator('button:has-text("Envoyer")').last().click()
    await page.waitForSelector('text=Confirmer l\'envoi du courriel', { timeout: 5000 })
    assert.ok(await page.locator('text=suivi-e2e@orisha.test').count() > 0, 'la confirmation doit afficher l\'adresse')
    assert.ok(await page.locator(`text=${trackingNumber}`).count() > 0, 'la confirmation doit afficher le n° de suivi')
    assert.equal(sendCount, 0, 'aucun /send-tracking avant confirmation')

    // Confirme → toast d'annulation visible, pas encore d'appel.
    await page.locator('button:has-text("Envoyer")').last().click()
    await page.locator('[data-testid="undo-send-toast"]').waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(sendCount, 0, '/send-tracking ne doit pas partir avant la fin du compte à rebours')

    // Fin du compte à rebours → toast de succès (émis après l'appel API).
    await page.locator('text=Courriel de suivi envoyé à suivi-e2e@orisha.test').first().waitFor({ state: 'visible', timeout: 14000 })
    assert.equal(sendCount, 1)
  })

  test('Annuler dans le toast empêche tout appel /send-tracking', async () => {
    await openTrackingModal('annule-trk@orisha.test')

    let sendCount = 0
    await page.route('**/api/shipments/*/send-tracking', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.locator('button:has-text("Envoyer")').last().click()
    await page.waitForSelector('text=Confirmer l\'envoi du courriel', { timeout: 5000 })
    await page.locator('button:has-text("Envoyer")').last().click()

    const toast = page.locator('[data-testid="undo-send-toast"]')
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-testid="undo-send-cancel"]').click()
    await toast.waitFor({ state: 'hidden', timeout: 5000 })
    await page.locator('text=Envoi annulé').first().waitFor({ state: 'visible', timeout: 5000 })

    await page.waitForTimeout(11000)
    assert.equal(sendCount, 0, 'aucun /send-tracking après annulation')
  })
})
