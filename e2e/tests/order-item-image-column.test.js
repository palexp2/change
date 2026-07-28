// Vérifie que la colonne « Image » du tableau Articles d'une commande affiche
// bien l'image (vignette <img>) et non l'URL brute de l'image.
// Régression signalée depuis /orders/:id : la cellule montrait le lien texte
// Airtable au lieu de la photo du produit.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const BASE = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
const TOKEN = process.env.ERP_TOKEN
if (!PASS && !TOKEN) throw new Error('ERP_PASS or ERP_TOKEN env var required')

// Commande de référence connue pour contenir au moins un article avec une image
// (URL d'attachement Airtable).
const ORDER_ID = '91235aeb-1d64-430f-86e0-4c233bcc5a0a'

describe('OrderDetail — colonne Image = vignette, pas URL', () => {
  let browser, ctx, page, pageErrors

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    if (TOKEN) {
      // Injection d'un JWT valide (minté via JWT_SECRET) : le mot de passe du
      // compte de test local n'est pas stocké — cf. mémoire E2E.
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
      await page.evaluate(t => localStorage.setItem('erp_token', t), TOKEN)
    } else {
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
      await page.fill('input[type="email"]', EMAIL)
      await page.fill('input[type="password"]', PASS)
      await page.click('button:has-text("Se connecter")')
      await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    }
  })

  after(async () => { await browser?.close() })

  test('la cellule Image rend une <img> Airtable', async () => {
    await page.goto(`${BASE}/orders/${ORDER_ID}`, { waitUntil: 'networkidle' })
    // Attendre que la section Articles soit montée.
    await page.waitForSelector('h2:has-text("Articles")', { timeout: 10000 })

    // La vignette est un <img> dont la source pointe vers l'hôte d'attachements
    // Airtable — c'est ce que produit ImageValue pour le champ « Image ».
    const thumb = page.locator('img[src*="airtableusercontent.com"]').first()
    await thumb.waitFor({ state: 'visible', timeout: 8000 })
    assert.ok(await thumb.count() >= 1, 'au moins une vignette image doit être rendue')

    // La cellule ne doit PAS afficher l'URL brute en texte.
    const rawUrlText = await page.locator('text=/v5\\.airtableusercontent\\.com/').count()
    assert.equal(rawUrlText, 0, "l'URL brute ne doit pas apparaître en texte dans la cellule")

    // Régression « image trop grosse qui déborde de la ligne » : la vignette
    // doit tenir dans la hauteur d'une ligne du DataTable (32px), sinon elle
    // chevauche les lignes voisines. On tolère la petite marge du rendu.
    const thumbHeight = await thumb.evaluate(el => el.getBoundingClientRect().height)
    assert.ok(thumbHeight <= 32, `la vignette (${thumbHeight}px) ne doit pas dépasser la hauteur de ligne (32px)`)

    assert.equal(pageErrors.length, 0, `pageerror inattendue : ${pageErrors.join(' | ')}`)
  })
})
