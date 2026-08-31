// Vérifie que le champ « Image » d'un article de commande affiche une vraie
// image (vignette <img>) et non l'URL brute / un lien texte.
// Régression signalée depuis /orders/<id> : le champ montrait un lien vers une
// image au lieu de l'image elle-même.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Commande de référence contenant un article avec une image (attachment Airtable).
const ORDER_ID = '91235aeb-1d64-430f-86e0-4c233bcc5a0a'

describe('Commande — champ Image affiché comme image', () => {
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

  test('la cellule Image contient un <img> et non un lien texte', async () => {
    await page.goto(`${URL}/orders/${ORDER_ID}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/Articles/', { timeout: 10000 })

    // Une balise <img> doit être rendue. Sa source est la copie locale de la
    // pièce jointe posée par la sync Airtable (les URL d'attachment expirent en
    // quelques heures) — d'où le test sur le testid plutôt que sur le domaine.
    const img = page.locator('[data-testid="cf-image-thumb"]').first()
    await img.waitFor({ state: 'visible', timeout: 10000 })
    const src = await img.getAttribute('src')
    assert.ok(src && (src.startsWith('/') || src.startsWith('http')), `src d'image attendu, reçu : ${src}`)
    assert.ok(await img.evaluate(el => el.complete && el.naturalWidth > 0),
      `l'image ${src} ne s'est pas chargée`)

    // La cellule ne doit PAS afficher l'URL brute en texte (ancien comportement).
    const rawUrlText = page.locator('td:has-text("airtableusercontent.com")')
    assert.equal(await rawUrlText.count(), 0, 'aucune URL brute ne doit être affichée en texte')

    assert.equal(pageErrors.length, 0, `pageerror inattendue : ${pageErrors.join(' | ')}`)
  })
})
