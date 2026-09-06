// Mode expédition / décochage d'un article :
//   quand on remet un article à "À prélever" (en cliquant la rangée d'un
//   article déjà "Prélevé"), tous les numéros de série liés à cet item doivent
//   être détachés (order_item_id remis à NULL). Cas pratique : le picker scanne
//   le mauvais serial, clique pour décocher, rescanne le bon.
//
// Le test :
//   - crée une commande de test rattachée à une company existante
//   - trouve un serial libre (order_item_id IS NULL) en stock
//   - scanne ce serial en mode pick → l'item est créé + serial lié
//   - clique l'avatar de la rangée pour décocher → status revient à "À prélever"
//   - vérifie que le serial est détaché (order_item_id NULL)
//
// Cleanup : delete la commande créée et restaure l'order_item_id du serial.

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

describe('Mode expédition — décocher un article détache ses serials', () => {
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

    // 2. Crée une company de test (pour ne pas polluer une vraie commande).
    const co = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E UncheckSerial ${Date.now()}` }),
    })
    assert.ok(co.status === 200 || co.status === 201)
    companyId = co.body.id

    // 3. Crée une commande de test.
    const ord = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, status: 'En cours', notes: 'E2E uncheck-serial' }),
    })
    assert.ok(ord.status === 200 || ord.status === 201)
    orderId = ord.body.id

    // 4. Ajoute un item du même produit que le serial.
    const it = await apiFetch(page, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, qty: 1 }),
    })
    assert.ok(it.status === 200 || it.status === 201)
    itemId = it.body.id || (await apiFetch(page, `/api/orders/${orderId}`)).body.items[0].id
    assert.ok(itemId)

    // 5. Scan en mode pick → pique l'item et lie le serial.
    const scan = await apiFetch(page, `/api/orders/${orderId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ value: serialValue, mode: 'pick' }),
    })
    assert.equal(scan.status, 200, `scan: ${JSON.stringify(scan.body)}`)
    assert.equal(scan.body.action, 'picked', `scan action devrait être 'picked' — reçu: ${scan.body.action}`)

    // 6. Vérifie que le serial est bien lié (préambule).
    const sn = await apiFetch(page, `/api/serials/${serialId}`)
    assert.equal(sn.body.order_item_id, itemId, 'serial devrait être lié à l\'item après scan')
  })

  after(async () => {
    // Détache toujours le serial avant de cleanup (filet de sécurité — si on
    // ne détache pas, supprimer la commande pourrait laisser un serial avec
    // un order_item_id pointant vers un enregistrement supprimé).
    if (serialId && orderId) {
      // Force unpick l'item pour détacher le serial.
      if (itemId) {
        try { await apiFetch(page, `/api/orders/${orderId}/items/${itemId}`, {
          method: 'PATCH', body: JSON.stringify({ fulfillment_status: 'À prélever', fulfilled_qty: 0 })
        }) } catch {}
      }
    }
    if (orderId)   try { await apiFetch(page, `/api/orders/${orderId}`,   { method: 'DELETE' }) } catch {}
    if (companyId) try { await apiFetch(page, `/api/companies/${companyId}`, { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('PATCH fulfillment_status: "À prélever" détache les serials côté serveur', async () => {
    const patch = await apiFetch(page, `/api/orders/${orderId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fulfillment_status: 'À prélever', fulfilled_qty: 0 }),
    })
    assert.equal(patch.status, 200)
    // La réponse doit inclure serials=[] (le client en a besoin pour mettre à
    // jour le badge sans refetch).
    assert.deepEqual(patch.body.serials, [], `la réponse PATCH devrait contenir serials=[] — reçu: ${JSON.stringify(patch.body.serials)}`)

    // Le serial doit être détaché en DB.
    const sn = await apiFetch(page, `/api/serials/${serialId}`)
    assert.equal(sn.body.order_item_id, null, `order_item_id devrait être NULL après décochage — reçu: ${sn.body.order_item_id}`)
  })

  test('UI : décocher la rangée fait disparaître le badge du serial', async () => {
    // Re-scan pour relier le serial avant le test UI.
    await apiFetch(page, `/api/orders/${orderId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ value: serialValue, mode: 'pick' }),
    })

    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    // Le serial badge devrait être visible dans la section "Prélevé".
    await page.locator(`text=${serialValue}`).first().waitFor({ state: 'visible', timeout: 5000 })

    // Trouve la rangée qui contient le serial (dans Prélevé) et clique pour décocher.
    const row = page.locator('div', { hasText: serialValue }).filter({ has: page.locator('div.rounded-full') }).first()
    await row.click()

    // Le badge du serial doit disparaître.
    await page.locator(`text=${serialValue}`).first().waitFor({ state: 'hidden', timeout: 5000 })

    // Vérifie en DB via API que c'est bien détaché.
    const sn = await apiFetch(page, `/api/serials/${serialId}`)
    assert.equal(sn.body.order_item_id, null)
  })
})
