// OrderDetail / Mode expédition :
//   - sur chaque ligne du bloc « Envois de cette commande », un bouton
//     « Étiquette Novoxpress » (ou « Réimprimer ») apparaît quand Novoxpress
//     est configuré. Cliquer ouvre la modale Novoxpress (étape « package »)
//     qui permet de saisir le poids et obtenir les tarifs.
//
// Le test ne complète pas l'achat — ça facturerait l'étiquette sur le compte
// Novoxpress de prod. Il vérifie juste que le bouton est présent et que la
// modale s'ouvre correctement avec son contenu attendu.

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

describe('OrderDetail — bouton Novoxpress sur les envois', () => {
  let browser, ctx, page
  let orderId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Skip si Novoxpress pas configuré sur cet env.
    const status = await apiFetch(page, '/api/novoxpress/status')
    if (!status.body || !status.body.configured) {
      throw new Error('Novoxpress non configuré — test skip')
    }

    // Trouve une commande qui a au moins un shipment.
    const found = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/orders?limit=200', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then(r => r.json())
      for (const o of (list.data || [])) {
        const detail = await fetch(`/erp/api/orders/${o.id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(r => r.json())
        if ((detail.shipments || []).length >= 1) {
          return { id: o.id }
        }
      }
      return null
    })
    assert.ok(found, 'aucune commande avec ≥1 shipment trouvée')
    orderId = found.id
  })

  after(async () => {
    await browser?.close()
  })

  test('le bouton Novoxpress apparaît sur chaque envoi en mode expédition et ouvre la modale', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'networkidle' })

    // Passer en mode expédition.
    await page.getByRole('button', { name: /Mode expédition/ }).click()
    await page.getByRole('button', { name: /Vue commerciale/ }).waitFor({ state: 'visible', timeout: 5000 })

    // Le bloc "Envois de cette commande" doit être présent.
    await page.locator('h2:has-text("Envois de cette commande")').waitFor({ state: 'visible', timeout: 5000 })

    // Au moins un bouton "Étiquette Novoxpress" ou "Réimprimer" doit être présent.
    const novoBtn = page.locator('button', { hasText: /Étiquette Novoxpress|Réimprimer/ }).first()
    await novoBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Cliquer ouvre la modale.
    await novoBtn.click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'visible', timeout: 5000 })

    // L'étape "package" affiche le sélecteur de type de colis.
    await page.locator('text=Type de colis').first().waitFor({ state: 'visible' })
    await page.locator('text=Moyenne (20 × 16 × 8 po)').first().waitFor({ state: 'visible' })
    // L'option Enveloppe doit aussi être présente dans les choix.
    await page.locator('text=Enveloppe (documents légers)').first().waitFor({ state: 'visible' })
    // Pour un colis « boîte », le poids et la quantité sont visibles.
    await page.locator('label:has-text("Poids total")').first().waitFor({ state: 'visible' })

    // Sélection enveloppe → poids et nombre de colis doivent disparaître.
    await page.locator('label:has-text("Enveloppe")').first().click()
    await page.locator('label:has-text("Poids total")').first().waitFor({ state: 'hidden', timeout: 2000 })
    await page.locator('label:has-text("Nombre de colis")').first().waitFor({ state: 'hidden', timeout: 2000 })

    // Vérifier que demander les tarifs en mode enveloppe envoie packaging_type='envelope'
    // avec des dimensions entières (Novoxpress refuse les décimaux) et poids ≥ 1.
    let lastRatesPayload = null
    await page.route('**/api/novoxpress/rates/**', async route => {
      try { lastRatesPayload = JSON.parse(route.request().postData() || '{}') } catch {}
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ request_id: 'test', rates: [] }),
      })
    })

    await page.getByRole('button', { name: /Obtenir les tarifs/ }).click()
    for (let i = 0; i < 20 && !lastRatesPayload; i++) await page.waitForTimeout(100)
    assert.ok(lastRatesPayload, 'le call /novoxpress/rates aurait dû être intercepté')
    assert.equal(lastRatesPayload.packaging_type, 'envelope', `packaging_type devrait être 'envelope' — reçu: ${lastRatesPayload.packaging_type}`)
    const pkg = (lastRatesPayload.packages || [])[0] || {}
    // Les dimensions et le poids doivent être des entiers valides (Novoxpress rejette '12.5' ou '0').
    assert.ok(/^\d+$/.test(pkg.length), `length devrait être entier — reçu: ${pkg.length}`)
    assert.ok(/^\d+$/.test(pkg.width), `width devrait être entier — reçu: ${pkg.width}`)
    assert.ok(/^\d+$/.test(pkg.depth), `depth devrait être entier — reçu: ${pkg.depth}`)
    assert.ok(parseInt(pkg.weight, 10) >= 1, `weight devrait être ≥ 1 — reçu: ${pkg.weight}`)

    // Le bloc de diagnostics doit apparaître quand 0 tarif disponible (avec
    // au minimum le payload envoyé visible pour aider à debugger).
    await page.locator('text=Aucun tarif disponible pour cet envoi').first().waitFor({ state: 'visible', timeout: 5000 })
    const debugBlock = page.locator('text=Détails techniques').first()
    await debugBlock.waitFor({ state: 'visible', timeout: 3000 })
    await debugBlock.click() // déplier le <details>
    await page.locator('text=Payload envoyé à Novoxpress').first().waitFor({ state: 'visible', timeout: 3000 })

    // Revenir à l'étape package et fermer.
    await page.getByRole('button', { name: /← Retour/ }).click()
    await page.getByRole('button', { name: /^Annuler$/ }).click()
    await page.locator('text=Créer une étiquette postale').first().waitFor({ state: 'hidden', timeout: 5000 })
    await page.unroute('**/api/novoxpress/rates/**')
  })

  test('lien « Détails → » vers /envois/:id apparaît aussi sur chaque envoi', async () => {
    // (Page déjà sur /orders/:id en mode expédition après le test précédent.)
    const detailLink = page.locator('a:has-text("Détails →")').first()
    await detailLink.waitFor({ state: 'visible', timeout: 5000 })
    const href = await detailLink.getAttribute('href')
    assert.ok(href && href.startsWith('/erp/envois/'), `href devrait pointer vers /erp/envois/* — reçu: ${href}`)
  })
})
