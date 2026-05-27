// OrderDetail / Mode expédition / modale "Créer un envoi avec X articles" :
//   le formulaire ne doit PAS contenir les champs "Transporteur" et "N° de
//   suivi" (déplacés vers l'étiquette Novoxpress qui les remplit
//   automatiquement à l'achat). Seuls "Articles dans cet envoi" et "Notes"
//   doivent rester visibles.
//
// Le test crée une commande de test avec 1 article, le passe en statut
// "Prélevé" via API, puis ouvre la modale et vérifie son contenu. Cleanup
// dans after() : supprime la commande créée.

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

describe('OrderDetail / Mode expédition — modale Créer un envoi : champs simplifiés', () => {
  let browser, ctx, page
  let orderId = null
  let itemId = null
  let companyId = null
  let productId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Prend la 1ère company et le 1er produit dispo pour rattacher la commande.
    const companies = await apiFetch(page, '/api/companies?limit=1')
    assert.ok(companies.body.data?.length, 'aucune company disponible')
    companyId = companies.body.data[0].id

    const products = await apiFetch(page, '/api/products?limit=1')
    assert.ok(products.body.data?.length, 'aucun produit disponible')
    productId = products.body.data[0].id

    // Crée une commande de test.
    const orderRes = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, status: 'En cours', notes: `E2E create-shipment modal ${Date.now()}` }),
    })
    assert.ok(orderRes.status === 200 || orderRes.status === 201, `order create failed: ${JSON.stringify(orderRes.body)}`)
    orderId = orderRes.body.id

    // Ajoute un article.
    const itemRes = await apiFetch(page, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, qty: 1 }),
    })
    assert.ok(itemRes.status === 200 || itemRes.status === 201, `item add failed: ${JSON.stringify(itemRes.body)}`)
    itemId = itemRes.body.id || itemRes.body?.item?.id
    if (!itemId) {
      const detail = await apiFetch(page, `/api/orders/${orderId}`)
      itemId = (detail.body.items || [])[0]?.id
    }
    assert.ok(itemId, 'item id missing')

    // Passe l'article en "Prélevé" pour faire apparaître le bouton "Créer un envoi".
    const patch = await apiFetch(page, `/api/orders/${orderId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fulfillment_status: 'Prélevé', fulfilled_qty: 1 }),
    })
    assert.equal(patch.status, 200)
  })

  after(async () => {
    if (orderId) {
      try { await apiFetch(page, `/api/orders/${orderId}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('la modale "Créer un envoi" n\'affiche plus Transporteur ni N° de suivi', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // Passe en mode expédition.
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    // Bouton "Créer un envoi avec X article(s)".
    const createBtn = page.locator('button', { hasText: /Créer un envoi avec/ }).first()
    await createBtn.waitFor({ state: 'visible', timeout: 5000 })
    await createBtn.click()

    // Modale ouverte.
    const dialog = page.locator('[role="dialog"], .fixed.inset-0').filter({ hasText: 'Articles dans cet envoi' }).first()
    await dialog.waitFor({ state: 'visible', timeout: 5000 })

    // Contenu attendu : Articles + Notes.
    await dialog.locator('label:has-text("Articles dans cet envoi")').waitFor({ state: 'visible' })
    await dialog.locator('label:has-text("Notes")').waitFor({ state: 'visible' })

    // Contenu retiré : Transporteur + N° de suivi.
    const carrierCount = await dialog.locator('label:has-text("Transporteur")').count()
    assert.equal(carrierCount, 0, 'le label "Transporteur" devrait avoir été retiré du formulaire')

    const trackingCount = await dialog.locator('label:has-text("N° de suivi")').count()
    assert.equal(trackingCount, 0, 'le label "N° de suivi" devrait avoir été retiré du formulaire')

    // Le placeholder "Purolator, FedEx..." du champ Transporteur ne doit plus être présent.
    const placeholderCount = await dialog.locator('input[placeholder*="Purolator"]').count()
    assert.equal(placeholderCount, 0, 'l\'input avec placeholder Purolator/FedEx devrait avoir été retiré')

    // Fermer la modale.
    await dialog.locator('button', { hasText: /^Annuler$/ }).click()
  })
})
