// Colonne « Image » du tableau Articles d'une commande (/orders/:id).
// Le champ custom Airtable « Image » stocke une URL de pièce jointe qui expire
// après quelques heures : la cellule finissait par afficher l'URL en toutes
// lettres au lieu d'une image. La colonne doit désormais afficher la vignette du
// produit lié (image locale, jamais périmée) — et jamais une URL textuelle.
// Test 100% lecture seule : aucune donnée n'est créée ni modifiée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

describe('Commande — colonne « Image » des articles', () => {
  let browser, ctx, page, db
  let orderId, itemId, productImage

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })
    // Une commande dont un article porte à la fois une URL Airtable (« image »,
    // potentiellement expirée) et un produit lié avec image locale. On privilégie
    // la commande signalée par l'utilisateur, avec repli sur n'importe quelle
    // autre qui remplit les conditions (le jeu de données peut évoluer).
    const pick = db.prepare(`
      SELECT oi.id AS item_id, oi.order_id, pr.image_url
      FROM order_items oi
      JOIN products pr ON pr.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.image IS NOT NULL AND oi.image <> ''
        AND pr.image_url IS NOT NULL AND pr.image_url <> ''
        AND o.deleted_at IS NULL
        AND (? IS NULL OR oi.order_id = ?)
      ORDER BY oi.created_at DESC
      LIMIT 1
    `)
    const REPORTED_ORDER = '7041033d-8673-4e95-996c-a54ce0c3c159'
    const row = pick.get(REPORTED_ORDER, REPORTED_ORDER) || pick.get(null, null)
    assert.ok(row, 'au moins un article de commande avec image Airtable + image produit locale doit exister')
    orderId = row.order_id
    itemId = row.item_id
    productImage = row.image_url

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    db?.close()
    await browser?.close()
  })

  test('la cellule Image affiche la vignette du produit et non une URL', async () => {
    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const row = page.locator(`[data-row-id="${itemId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })

    // Une vignette <img> est rendue, avec la source LOCALE du produit (et non
    // l'URL airtableusercontent.com qui expire).
    const thumb = row.locator('[data-testid="cf-image-thumb"]').first()
    await thumb.waitFor({ state: 'visible', timeout: 10000 })
    const src = await thumb.getAttribute('src')
    assert.equal(src, productImage, `la vignette doit pointer vers l'image locale du produit, reçu: ${src}`)

    // L'image doit réellement se charger (fichier servi par le serveur), sinon
    // le composant basculerait sur le placeholder « image indisponible ».
    const loaded = await thumb.evaluate(img => img.complete && img.naturalWidth > 0)
    assert.equal(loaded, true, "la vignette doit se charger (image locale servie par l'app)")

    // Et surtout : aucune URL en toutes lettres dans la ligne.
    const rowText = (await row.textContent()) || ''
    assert.ok(!rowText.includes('airtableusercontent.com'), `la ligne ne doit pas afficher d'URL d'image, reçu: ${rowText}`)
    assert.ok(!/https?:\/\//.test(rowText), `la ligne ne doit pas afficher d'URL en texte, reçu: ${rowText}`)
  })
})
