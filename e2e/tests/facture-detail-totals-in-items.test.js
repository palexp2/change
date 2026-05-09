// Vérifie que sur la fiche détaillée d'une facture, les sommaires (Avant taxes,
// Taxes, Total) sont rendus comme lignes de pied dans la table « Lignes de la
// facture » et non plus dans une grille « Montants » séparée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FactureDetail — sommaires dans la section Lignes', () => {
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

  test('Avant taxes / Taxes (si présentes) / Total apparaissent dans la table items', async () => {
    // On cible une facture avec des taxes pour valider la ligne taxes en plus.
    const target = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch('/erp/api/projets/factures?limit=all', { headers: h }).then(r => r.json())
      const all = list.data || []
      // Charger les détails des 25 plus récentes pour trouver une avec taxes[]
      for (const f of all.slice(0, 25)) {
        const d = await fetch(`/erp/api/projets/factures/${f.id}`, { headers: h }).then(r => r.json())
        if (Array.isArray(d.taxes) && d.taxes.length > 0 && d.total_amount) {
          return { id: f.id, taxesCount: d.taxes.length, currency: d.currency, total: d.total_amount }
        }
      }
      // fallback : juste une facture avec total
      const any = all.find(f => f.total_amount)
      return any ? { id: any.id, taxesCount: 0, currency: any.currency, total: any.total_amount } : null
    })
    assert.ok(target, 'au moins une facture avec un total est requise')

    await page.goto(`${URL}/factures/${target.id}`, { waitUntil: 'networkidle' })
    const itemsCard = page.locator('[data-testid="facture-items"]')
    await itemsCard.waitFor({ timeout: 5000 })

    // Sous-total et Total doivent toujours être présents
    await itemsCard.locator('[data-testid="facture-line-subtotal"]').waitFor({ timeout: 3000 })
    await itemsCard.locator('[data-testid="facture-line-total"]').waitFor({ timeout: 3000 })

    const subText = (await itemsCard.locator('[data-testid="facture-line-subtotal"]').innerText()).trim()
    assert.match(subText, /Avant taxes/, `attendu "Avant taxes" dans la ligne sous-total : ${subText}`)

    const totalText = (await itemsCard.locator('[data-testid="facture-line-total"]').innerText()).trim()
    assert.match(totalText, /^Total\b/m, `attendu "Total" dans la ligne total : ${totalText}`)

    // Si la facture a des taxes, vérifier qu'au moins une ligne taxe est rendue
    if (target.taxesCount > 0) {
      const taxRows = await itemsCard.locator('[data-testid="facture-line-tax"]').count()
      assert.equal(taxRows, target.taxesCount, `nb taxes attendu ${target.taxesCount}, vu ${taxRows}`)
    }

    // Et l'ancienne grille "Montants" (3 colonnes Avant taxes / Total / Solde dû)
    // ne doit plus exister : il ne doit y avoir qu'un libellé "Avant taxes" et un seul "Total"
    // dans toute la page (ceux de la table).
    const avantTaxesCount = await page.locator('text=/^Avant taxes$/').count()
    assert.equal(avantTaxesCount, 1, `un seul label "Avant taxes" attendu (table footer), vu ${avantTaxesCount}`)

    // "Solde dû" doit toujours être présent ailleurs sur la page
    const soldeDuCount = await page.locator('text=/^Solde dû$/').count()
    assert.equal(soldeDuCount, 1, `un seul label "Solde dû" attendu, vu ${soldeDuCount}`)
  })
})
