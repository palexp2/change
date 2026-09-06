// Régression : avant le fix du webhook stripe-webhooks.js (mai 2026),
// les nouveaux abonnements de mai n'avaient AUCUN produit affiché dans le
// panel "Mouvements d'abonnements" du dashboard parce que
// upsertFromInvoiceLines() n'était jamais appelé depuis le webhook —
// seulement depuis le batch-enrich et le backfill. Conséquence :
// stripe_invoice_items vide pour toute facture créée par webhook après
// le 1er mai 2026.
//
// Ce test vérifie que pour un mois donné de l'année courante (mai 2026),
// au moins une entreprise dans la catégorie "creation" a une liste de
// produits non vide. Si ça repasse à zéro, c'est que le webhook ne
// upsert plus les items et la régression est revenue.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — Mouvements d\'abonnements mai 2026 — produits non vides (régression webhook)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('mai 2026 : au moins un creation a products[] non vide', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/subscription-events?months=24', {
        headers: { Authorization: `Bearer ${tok}` },
      })
      return r.json()
    })

    assert.ok(Array.isArray(data.months), 'months doit être un array')
    const may = data.months.find(m => m.month === '2026-05')
    assert.ok(may, `mois 2026-05 absent du payload — months=${data.months.map(m => m.month).join(',')}`)

    // creation peut être vide pour un mois donné si aucun nouvel abonnement,
    // mais en mai 2026 (mois en cours du test) on a confirmé qu'il y a des
    // creations en DB. On vérifie d'abord qu'il y en a.
    assert.ok(
      may.categories.creation.count >= 1,
      `mai 2026 : aucun event creation — count=${may.categories.creation.count}`,
    )

    const items = may.categories.creation.items
    const withProducts = items.filter(it => Array.isArray(it.products) && it.products.length > 0)
    assert.ok(
      withProducts.length >= 1,
      `mai 2026 : aucun creation avec products[] non vide — items=${JSON.stringify(items.map(i => ({ company: i.company_name, products: i.products?.length || 0 })))}`,
    )

    // Sanity check : un produit doit avoir un nom non vide
    const sampleProduct = withProducts[0].products[0]
    assert.ok(
      typeof sampleProduct.product_name === 'string' && sampleProduct.product_name.length > 0,
      'product_name vide sur un item creation de mai 2026',
    )
    console.log(`  → mai 2026 : ${withProducts.length}/${items.length} creations avec produits. Exemple : ${withProducts[0].company_name} → ${withProducts[0].products.map(p => p.product_name).join(', ')}`)
  })
})
