// EnvoisDetail — bouton "Supprimer" dans la modale "Modifier l'envoi" :
//   crée un envoi de test rattaché à une commande existante, ouvre la modale
//   d'édition, clique "Supprimer", confirme dans la modale de confirmation,
//   et vérifie que l'envoi est soft-deleted (GET /api/shipments/:id → 404)
//   et qu'on a été redirigé vers /envois.
//
// Cleanup : le test crée l'envoi lui-même ; si jamais la suppression UI
// échoue, le after() force un DELETE via API pour ne pas polluer la DB.

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

describe('EnvoisDetail — supprimer un envoi depuis la modale Modifier', () => {
  let browser, ctx, page
  let createdShipmentId = null
  let orderId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Trouve n'importe quelle commande existante.
    const list = await apiFetch(page, '/api/orders?limit=10')
    assert.equal(list.status, 200)
    assert.ok(list.body.data?.length, 'aucune commande disponible pour le test')
    orderId = list.body.data[0].id

    // Crée un envoi de test.
    const created = await apiFetch(page, '/api/shipments', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        tracking_number: `E2E-DEL-${Date.now()}`,
        carrier: 'E2E Test',
        notes: 'E2E test shipment — to be deleted',
      }),
    })
    assert.ok(created.status === 200 || created.status === 201, `shipment create failed (${created.status}): ${JSON.stringify(created.body)}`)
    createdShipmentId = created.body.id
    assert.ok(createdShipmentId, 'shipment id missing')
  })

  after(async () => {
    // Filet de sécurité : si la suppression UI a échoué, on supprime via API
    // pour ne pas polluer la DB. Si déjà supprimé, le 404 est OK.
    if (createdShipmentId) {
      try { await apiFetch(page, `/api/shipments/${createdShipmentId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('clic Modifier → Supprimer → confirme → envoi soft-deleted + redirection vers /envois', async () => {
    await page.goto(`${URL}/envois/${createdShipmentId}`, { waitUntil: 'networkidle' })

    // Vérifie qu'on est bien sur la page détail.
    await page.locator('h1', { hasText: /Envoi/ }).first().waitFor({ state: 'visible', timeout: 5000 })

    // Ouvre la modale "Modifier".
    await page.getByRole('button', { name: /^Modifier$/ }).click()

    // La modale est ouverte — le bouton Supprimer doit y être visible.
    const deleteBtn = page.getByRole('button', { name: /^Supprimer$/ })
    await deleteBtn.waitFor({ state: 'visible', timeout: 5000 })
    await deleteBtn.click()

    // Modale de confirmation : titre + bouton "Supprimer".
    await page.locator('text=Supprimer cet envoi').first().waitFor({ state: 'visible', timeout: 5000 })
    // Le bouton de confirmation dans ConfirmModal est aussi nommé "Supprimer".
    // On clique le dernier "Supprimer" visible (celui de la modale de confirmation).
    const allDeleteBtns = page.getByRole('button', { name: /^Supprimer$/ })
    await allDeleteBtns.last().click()

    // Redirection vers /envois.
    await page.waitForURL(u => /\/envois\/?(\?|$)/.test(u.toString()) && !u.toString().includes(createdShipmentId), { timeout: 10000 })

    // Vérifie via API que l'envoi n'apparaît plus dans la liste (filtrage deleted_at IS NULL).
    const list = await apiFetch(page, `/api/shipments?order_id=${orderId}&limit=all`)
    assert.equal(list.status, 200)
    const stillThere = (list.body.data || []).some(s => s.id === createdShipmentId)
    assert.equal(stillThere, false, 'shipment ne devrait plus apparaître dans la liste après soft-delete')

    // GET /api/shipments/:id doit retourner 404 après soft-delete (sinon
    // revisiter l'URL /envois/:id ré-affichait l'envoi pourtant supprimé).
    const detail = await apiFetch(page, `/api/shipments/${createdShipmentId}`)
    assert.equal(detail.status, 404, `GET shipment supprimé devrait retourner 404 — reçu: ${detail.status}`)

    // /envois/:id doit afficher "Envoi introuvable" si on revisite l'URL.
    await page.goto(`${URL}/envois/${createdShipmentId}`, { waitUntil: 'networkidle' })
    await page.locator('text=Envoi introuvable').first().waitFor({ state: 'visible', timeout: 5000 })

    // On marque comme déjà supprimé pour le after() — pas besoin du filet de sécurité.
    createdShipmentId = null
  })
})
