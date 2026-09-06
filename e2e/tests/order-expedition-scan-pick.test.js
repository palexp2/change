// OrderDetail / Mode expédition — scan d'un pistolet code-barre :
//   Scanner un numéro de série (ex. TH5267, lié au produit « Capteur de
//   température ») dans la vue expédition doit marquer la ligne correspondante
//   comme « Prélevé » (fulfilled_qty incrémenté) — c.-à-d. l'associer au
//   produit dans le panier.
//
// Régression corrigée : le hook `useBarcodeScanner` vidait le buffer dès que
// deux frappes étaient espacées de > 50 ms. Un vrai pistolet (surtout
// Bluetooth / gigue USB) émet souvent à 60–100 ms/caractère, donc le buffer
// se vidait entre chaque caractère et `onScan` n'était jamais appelé. Ce test
// simule explicitement une frappe à 80 ms/caractère pour verrouiller le fix.
//
// La commande et l'item sont jetables (créés puis hard-delete en `after`), et
// le numéro de série est détaché avant suppression — DB de test = DB de prod.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Produit « Capteur de température et humidité BME280 - DS18 » + un de ses
// numéros de série disponibles. Stables en prod (sync Airtable).
const TEMP_PRODUCT_ID = 'c417616d-05b7-458a-b296-ffe8c6cc8104'
const SERIAL = 'TH5267'

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function api(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    if (init.body) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('OrderDetail — scan pistolet en mode expédition', () => {
  let browser, ctx, page
  let orderId, itemId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const created = await api(page, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ order_number: `E2E-SCAN-${Date.now()}` }),
    })
    assert.equal(created.status, 201, 'commande créée')
    orderId = created.body.id

    const item = await api(page, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: JSON.stringify({ product_id: TEMP_PRODUCT_ID, qty: 1, item_type: 'Facturable' }),
    })
    assert.equal(item.status, 201, 'ligne capteur ajoutée')
    itemId = item.body.id
  })

  after(async () => {
    // Détache le numéro de série (le scan l'avait lié à l'item) puis supprime
    // la commande jetable — même si le test a échoué.
    try {
      if (itemId) {
        await api(page, `/api/orders/${orderId}/items/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ fulfillment_status: 'À prélever', fulfilled_qty: 0 }),
        })
      }
      if (orderId) await api(page, `/api/orders/${orderId}?hard=true`, { method: 'DELETE' })
    } finally {
      if (browser) await browser.close()
    }
  })

  test('scanner TH5267 marque le capteur comme prélevé', async () => {
    await page.goto(`${URL}/orders/${orderId}?mode=expedition`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="expedition-view"]', { timeout: 10000 })

    // Aucun input focus → le listener global du hook reçoit les frappes.
    // Un vrai pistolet émet tout le code en rafale (<20 ms) puis Enter : on
    // dispatche les keydown en une rafale synchrone (timing déterministe, sans
    // la gigue de l'event loop headless qui couperait le buffer). Le 1er
    // caractère « T » exerce quand même le raccourci clavier global, ce qui
    // valide qu'il ne redirige plus.
    await page.evaluate((serial) => {
      document.body.focus()
      for (const ch of serial) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }, SERIAL)

    // Le scan déclenche un POST async ; on attend que la ligne bascule en
    // « Prélevé » côté serveur (lecture directe, hors cache prefetch).
    let item
    for (let i = 0; i < 25; i++) {
      const after = await api(page, `/api/orders/${orderId}`)
      item = (after.body.items || []).find(it => it.id === itemId)
      if (item && item.fulfillment_status === 'Prélevé') break
      await page.waitForTimeout(200)
    }

    // Le 1er caractère « T » ne doit PAS avoir déclenché le raccourci global
    // /feuille-de-temps : on reste sur la fiche commande en mode expédition.
    assert.ok(page.url().includes(`/orders/${orderId}`), `pas de redirection (url=${page.url()})`)
    assert.ok(await page.locator('[data-testid="expedition-view"]').count() > 0, 'toujours en vue expédition')

    assert.ok(item, 'item retrouvé')
    assert.equal(item.fulfillment_status, 'Prélevé', 'le capteur est prélevé')
    assert.equal(item.fulfilled_qty, 1, 'fulfilled_qty incrémenté à 1')
  })
})
