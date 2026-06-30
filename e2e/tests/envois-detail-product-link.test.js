// Vérifie que dans le tableau d'articles d'un envoi (EnvoisDetail), le nom du
// produit est rendu comme <Link> cliquable vers /products/:id (règle design FK)
// et non comme un simple label texte.
//
// Cas de référence : ENV-1609 — un seul article, le « Kit eye bolt », dont
// l'order_item porte product_id = 8b518e13-f3a2-458a-a313-a3198fbf484f.
//
// Lecture seule : aucun record créé, aucune config modifiée → pas de cleanup.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Envoi ENV-1609 — stable, déjà en DB (synced Airtable)
const ENV_1609_ID = '8cee15d1-2882-4bb5-a89a-4c058b53d83f'
const PRODUCT_ID = '8b518e13-f3a2-458a-a313-a3198fbf484f'

describe('Fiche envoi — nom de produit cliquable vers /products/:id', () => {
  let browser, ctx, page, pageErrors

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('le Kit eye bolt est un lien vers sa fiche produit', async () => {
    await page.goto(`${URL}/envois/${ENV_1609_ID}`, { waitUntil: 'networkidle' })

    const heading = page.locator('h2', { hasText: /Articles de l'envoi/ })
    await heading.waitFor({ state: 'visible', timeout: 10000 })
    const card = heading.locator('xpath=ancestor::div[contains(@class,"card")][1]')

    // La première cellule produit doit contenir un <a> pointant vers /products/:id
    const link = card.locator('tbody tr').first().locator('a[href*="/products/"]')
    await link.waitFor({ state: 'visible', timeout: 5000 })

    const href = await link.getAttribute('href')
    assert.ok(
      href.includes(`/products/${PRODUCT_ID}`),
      `href attendu .../products/${PRODUCT_ID}, reçu : ${href}`,
    )
    const text = await link.textContent()
    assert.ok(/eye bolt/i.test(text), `texte du lien attendu « eye bolt », reçu : ${text}`)

    // Le clic navigue bien vers la fiche produit
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/products/${PRODUCT_ID}`), { timeout: 10000 })

    assert.deepEqual(pageErrors, [], 'aucune erreur JS de page')
  })
})
