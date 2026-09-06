const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const EXCLUDED_STATUSES = [
  'Opérationnel - Vendu',
  'Opérationnel - Loué',
  'Détruit',
  "Utilisé par l'équipe Orisha",
  'Inconnu',
  'Non construit',
]

describe("Dashboard — Valeur de l'inventaire", () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('La section apparaît avec total, Pièces et statuts autorisés', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Tableau de bord")', { timeout: 10000 })

    const heading = page.locator("h2:has-text(\"Valeur de l'inventaire\")")
    await heading.waitFor({ timeout: 10000 })

    const card = page.locator('.card', { has: heading })
    await assert.doesNotReject(card.waitFor({ timeout: 5000 }))

    // Grand total label
    await assert.doesNotReject(
      card.locator('text=Cumul total').waitFor({ timeout: 3000 })
    )

    // "Pièces" row must exist
    const piecesRow = card.locator('text=Pièces').first()
    await piecesRow.waitFor({ timeout: 3000 })

    // At least one kept status should render (via the actual API data)
    const cardText = await card.innerText()
    const hasKeptStatus = [
      'Disponible - Vente',
      'Disponible - Location',
      'À reconditionner',
      'En retour',
      'À analyser',
    ].some(s => cardText.includes(s))
    assert.ok(hasKeptStatus, 'aucun statut de numéro de série autorisé affiché — contenu: ' + cardText)

    // None of the excluded statuses should appear as a row label
    for (const ex of EXCLUDED_STATUSES) {
      assert.ok(
        !cardText.includes(ex),
        `le statut exclu "${ex}" est affiché alors qu'il devrait être masqué`
      )
    }
  })

  test('Le total Pièces matche la vue « Valeur inventaire » de la table products', async () => {
    // La carte du dashboard doit afficher exactement la même somme que celle
    // qu'on obtiendrait en additionnant valeur_inventaire pour les produits
    // filtrés par la vue « Valeur inventaire » (pill 997d024c) :
    //   - type ∉ {JWT, SYSTEM, PIÈCE OBSOLÈTE, PRODUIT OBSOLÈTE}
    //   - type non vide
    //   - besoin_d_un_numero_de_serie ≠ '1.0'
    //   - deleted_at IS NULL (filtré côté API products)
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const dash = await (await fetch('/erp/api/dashboard', { headers: { Authorization: `Bearer ${tok}` } })).json()
      const prods = await (await fetch('/erp/api/products?limit=all', { headers: { Authorization: `Bearer ${tok}` } })).json()
      const list = Array.isArray(prods) ? prods : (prods.data || prods.items || [])
      const EXCLUDED = new Set(['JWT', 'SYSTEM', 'PIÈCE OBSOLÈTE', 'PRODUIT OBSOLÈTE'])
      const matching = list.filter(p =>
        p.besoin_d_un_numero_de_serie !== '1.0' &&
        p.type != null && String(p.type).trim() !== '' &&
        !EXCLUDED.has(p.type)
      )
      const expected = matching.reduce((s, p) => s + (Number(p.valeur_inventaire) || 0), 0)
      return {
        dashTotal: dash?.inventory?.valuation?.pieces?.total_value || 0,
        dashCount: dash?.inventory?.valuation?.pieces?.count || 0,
        expectedTotal: expected,
        expectedCount: matching.length,
      }
    })

    // Tolérance 0,01 $ pour arrondi flottant
    assert.ok(
      Math.abs(data.dashTotal - data.expectedTotal) < 0.01,
      `Pièces (dashboard) = ${data.dashTotal}, attendu (vue) = ${data.expectedTotal}. Les filtres ou la source diffèrent.`
    )
    assert.equal(
      data.dashCount,
      data.expectedCount,
      `Nombre de produits différent : dashboard=${data.dashCount}, vue=${data.expectedCount}`
    )
  })
})
