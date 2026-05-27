// Novoxpress — destinataire de l'étiquette :
//   - le courriel et le téléphone du destinataire viennent du contact rattaché
//     à l'adresse de livraison en priorité, et tombent sur la fiche entreprise
//     en fallback seulement.
//   - si les deux sources sont vides → POST /rates renvoie 400 avec un message
//     d'erreur explicite mentionnant ce qui manque.
//
// Cleanup : le test crée company/contact/address/order/shipment dédiés et les
// supprime via API à la fin.

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

describe('Novoxpress — destinataire issu du contact rattaché à l\'adresse', () => {
  let browser, ctx, page
  let companyId, contactId, addressId, orderId, shipmentId

  const ratesPayload = {
    packaging_type: 'package',
    packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    declared_value: '100',
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Skip si Novoxpress pas configuré (sinon le test ne peut pas valider le 200).
    const status = await apiFetch(page, '/api/novoxpress/status')
    if (!status.body?.configured) throw new Error('Novoxpress non configuré — test skip')

    // 1. Company SANS phone/email (cas Cropthorne — toute l'info est sur le contact)
    const co = await apiFetch(page, '/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E NovoxRecipient ${Date.now()}` }),
    })
    assert.ok(co.status === 200 || co.status === 201, `company create: ${JSON.stringify(co.body)}`)
    companyId = co.body.id

    // 2. Order rattachée
    const ord = await apiFetch(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ company_id: companyId, status: 'En cours', notes: 'E2E recipient test' }),
    })
    assert.ok(ord.status === 200 || ord.status === 201)
    orderId = ord.body.id

    // 3. Address SANS contact (pour tester l'erreur de validation)
    const adr = await apiFetch(page, '/api/adresses', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        line1: '123 Test Street',
        city: 'Québec',
        province: 'QC',
        postal_code: 'G1S2P1',
        country: 'CA',
      }),
    })
    assert.ok(adr.status === 200 || adr.status === 201, `address create: ${JSON.stringify(adr.body)}`)
    addressId = adr.body.id

    // 4. Shipment lié à l'order + address
    const sh = await apiFetch(page, '/api/shipments', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        address_id: addressId,
        tracking_number: `E2E-RCP-${Date.now()}`,
      }),
    })
    assert.ok(sh.status === 200 || sh.status === 201, `shipment create: ${JSON.stringify(sh.body)}`)
    shipmentId = sh.body.id
  })

  after(async () => {
    if (shipmentId) try { await apiFetch(page, `/api/shipments/${shipmentId}`, { method: 'DELETE' }) } catch {}
    if (orderId)    try { await apiFetch(page, `/api/orders/${orderId}`,       { method: 'DELETE' }) } catch {}
    if (addressId)  try { await apiFetch(page, `/api/adresses/${addressId}`,   { method: 'DELETE' }) } catch {}
    if (contactId)  try { await apiFetch(page, `/api/contacts/${contactId}`,   { method: 'DELETE' }) } catch {}
    if (companyId)  try { await apiFetch(page, `/api/companies/${companyId}`,  { method: 'DELETE' }) } catch {}
    await browser?.close()
  })

  test('POST /rates → 400 avec message explicite quand contact ET company sont vides', { timeout: 60000 }, async () => {
    const r = await apiFetch(page, `/api/novoxpress/rates/${shipmentId}`, {
      method: 'POST',
      body: JSON.stringify(ratesPayload),
    })
    assert.equal(r.status, 400, `attendu 400, reçu ${r.status} — body: ${JSON.stringify(r.body).slice(0, 200)}`)
    assert.match(r.body.error || '', /Coordonnées du destinataire manquantes/, `message d'erreur attendu, reçu: ${r.body.error}`)
    assert.match(r.body.error || '', /courriel/i)
    assert.match(r.body.error || '', /téléphone/i)
  })

  test('POST /rates → 200 quand un contact avec courriel + téléphone est rattaché à l\'adresse', { timeout: 60000 }, async () => {
    // Crée un contact avec courriel + téléphone
    const ct = await apiFetch(page, '/api/contacts', {
      method: 'POST',
      body: JSON.stringify({
        company_id: companyId,
        first_name: 'E2E',
        last_name: 'Recipient',
        email: 'e2e-recipient@example.com',
        phone: '1-604-910-5803',
      }),
    })
    assert.ok(ct.status === 200 || ct.status === 201, `contact create: ${JSON.stringify(ct.body)}`)
    contactId = ct.body.id

    // Attache le contact à l'adresse
    const upd = await apiFetch(page, `/api/adresses/${addressId}`, {
      method: 'PATCH',
      body: JSON.stringify({ contact_id: contactId }),
    })
    assert.ok(upd.status === 200, `address patch: ${JSON.stringify(upd.body)}`)

    // Maintenant /rates doit passer la validation locale.
    // (Le résultat upstream Novoxpress peut être 0 tarifs selon l'adresse de test,
    // mais l'endpoint doit retourner 200 et exposer recipient dans `sent`.)
    const r = await apiFetch(page, `/api/novoxpress/rates/${shipmentId}`, {
      method: 'POST',
      body: JSON.stringify(ratesPayload),
    })
    assert.equal(r.status, 200, `attendu 200, reçu ${r.status} — body: ${JSON.stringify(r.body).slice(0, 300)}`)
    assert.ok(r.body.sent?.recipient, 'le payload envoyé devrait inclure le destinataire')
    assert.equal(r.body.sent.recipient.email_address, 'e2e-recipient@example.com', 'courriel devrait venir du contact')
    // 1-604-910-5803 → 6049105803 (strip non-digits et préfixe pays)
    assert.equal(r.body.sent.recipient.address.phone_number, '6049105803', `téléphone devrait être normalisé à 10 chiffres — reçu: ${r.body.sent.recipient.address.phone_number}`)
  })
})
