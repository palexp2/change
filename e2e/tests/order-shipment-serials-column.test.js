// OrderDetail / Vue commerciale / tableau Expéditions :
//   une colonne "N° de série" doit afficher les numéros de série liés aux
//   articles de chaque envoi, sous forme de liens cliquables vers /serials/:id
//   (règle champs FK du CLAUDE.md).
//
// Le test :
//   - trouve un serial libre (order_item_id IS NULL) en stock
//   - crée une company + commande de test, ajoute un item du même produit
//   - scanne le serial en mode pick → serial lié à l'item
//   - crée un envoi avec cet item
//   - vérifie dans la vue commerciale que la colonne "N° de série" affiche
//     le serial en lien vers sa fiche
//
// Cleanup : détache le serial (unpick), supprime la commande et la company.

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

describe('OrderDetail / Expéditions — colonne N° de série', () => {
  let browser, ctx, page
  let companyId, orderId, itemId
  let serialId, serialValue, productId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // 1. Trouve un serial libre (et son product_id).
    const free = await apiFetch(page, '/api/serials?limit=all')
    assert.equal(free.status, 200)
    const candidate = (free.body.data || []).find(s => !s.order_item_id && s.product_id)
    assert.ok(candidate, 'aucun serial libre disponible pour le test')
    serialId = candidate.id
    serialValue = candidate.serial
    productId = candidate.product_id

    // 2. Company de test (pour ne pas polluer une vraie commande).
    const co = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E ShipSerialCol ${Date.now()}` }),
    })
    assert.ok(co.status === 200 || co.status === 201)
    companyId = co.body.id

    // 3. Commande de test.
    const ord = await apiFetch(page, '/api/orders', {
      method: 'POST',
      // NB: orders.status a une contrainte CHECK — 'En attente' est un statut valide.
      body: JSON.stringify({ company_id: companyId, status: 'En attente', notes: 'E2E shipment-serials-column' }),
    })
    assert.ok(ord.status === 200 || ord.status === 201)
    orderId = ord.body.id

    // 4. Item du même produit que le serial.
    const it = await apiFetch(page, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, qty: 1 }),
    })
    assert.ok(it.status === 200 || it.status === 201)
    itemId = it.body.id || (await apiFetch(page, `/api/orders/${orderId}`)).body.items[0].id
    assert.ok(itemId)

    // 5. Scan en mode pick → l'item passe "Prélevé" + serial lié.
    const scan = await apiFetch(page, `/api/orders/${orderId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ value: serialValue, mode: 'pick' }),
    })
    assert.equal(scan.status, 200, `scan: ${JSON.stringify(scan.body)}`)
    assert.equal(scan.body.action, 'picked', `scan action devrait être 'picked' — reçu: ${scan.body.action}`)

    // 6. Crée un envoi contenant l'item.
    const ship = await apiFetch(page, `/api/orders/${orderId}/shipments`, {
      method: 'POST',
      body: JSON.stringify({ carrier: 'E2E Carrier', item_ids: [itemId] }),
    })
    assert.ok(ship.status === 200 || ship.status === 201, `shipment create: ${JSON.stringify(ship.body)}`)
  })

  after(async () => {
    // Détache le serial avant cleanup (sinon DELETE order refuse à cause de la FK).
    if (orderId && itemId) {
      try { await apiFetch(page, `/api/orders/${orderId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ shipment_id: null, fulfillment_status: 'À prélever', fulfilled_qty: 0 }),
      }) } catch {}
    }
    if (orderId)   try { await apiFetch(page, `/api/orders/${orderId}`,      { method: 'DELETE' }) } catch {}
    if (companyId) try { await apiFetch(page, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('la colonne N° de série affiche le serial de l\'envoi en lien vers sa fiche', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // Vue commerciale par défaut — le tableau Expéditions doit avoir l'entête.
    const header = page.locator('th', { hasText: 'N° de série' })
    await header.waitFor({ state: 'visible', timeout: 10000 })

    // La cellule serials de l'envoi contient le serial en lien vers /serials/:id.
    const cell = page.locator('[data-testid="shipment-serials"]').first()
    await cell.waitFor({ state: 'visible', timeout: 5000 })
    const link = cell.locator(`a:has-text("${serialValue}")`)
    await link.waitFor({ state: 'visible', timeout: 5000 })
    const href = await link.getAttribute('href')
    assert.ok(href && href.includes(`/serials/${serialId}`), `le lien devrait pointer vers /serials/${serialId} — reçu: ${href}`)

    // Le clic sur le lien ne doit PAS déclencher la navigation de la rangée
    // vers /envois/:id mais bien ouvrir la fiche serial.
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/serials/${serialId}`), { timeout: 5000 })
  })
})
