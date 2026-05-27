// Vérifie que sur FactureDetail, la ligne "Avant taxes" affiche bien la valeur
// post-rabais (montant_avant_taxes − somme des rabais), pas la valeur brute
// pré-rabais que Stripe stocke dans invoice.subtotal.
//
// Cas concret : facture 60c4e062-c349-43e7-8309-5b49bf9bce2f (un rabais Stripe
// est appliqué). Avant le fix, "Avant taxes" affichait le subtotal Stripe brut,
// donc lignes − rabais ≠ "Avant taxes" et l'utilisateur voyait une incohérence.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FACTURE_ID = '60c4e062-c349-43e7-8309-5b49bf9bce2f'

describe('FactureDetail — Avant taxes inclut le rabais', () => {
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

  test('"Avant taxes" = subtotal stocké − somme des rabais affichés', async () => {
    // Charge les données via l'API pour connaître les valeurs attendues.
    // Les rabais sont sur une route séparée (chargée en parallèle côté front
    // pour ne pas bloquer le rendu sur l'appel Stripe live).
    const detail = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const [main, disc] = await Promise.all([
        fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        fetch(`/erp/api/projets/factures/${id}/discounts`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      ])
      return { ...main, discounts: disc.discounts || [] }
    }, FACTURE_ID)

    assert.ok(Array.isArray(detail.discounts) && detail.discounts.length > 0,
      `la facture test doit avoir au moins un rabais (sinon le test n'a pas de sens). discounts=${JSON.stringify(detail.discounts)}`)
    const discountSum = detail.discounts.reduce((s, d) => s + (Number(d.amount) || 0), 0)
    assert.ok(discountSum > 0, `somme des rabais doit être > 0, vu ${discountSum}`)

    const stored = detail.montant_avant_taxes != null
      ? parseFloat(detail.montant_avant_taxes)
      : Number(detail.amount_before_tax_cad)
    const expected = stored - discountSum

    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="facture-line-subtotal"]', { timeout: 10000 })
    // Les rabais sont chargés via une route séparée (round-trip Stripe live).
    // Attendre l'apparition de la ligne "Rabais" avant de lire "Avant taxes".
    await page.locator('[data-testid="facture-items"]').getByText(/Rabais/).first().waitFor({ timeout: 10000 })

    const cell = page.locator('[data-testid="facture-line-subtotal"] td').last()
    const rendered = (await cell.innerText()).trim()
    const parsed = parseFloat(rendered.replace(/[^0-9.,-]/g, '').replace(/\s/g, '').replace(',', '.'))

    assert.ok(
      Math.abs(parsed - expected) < 0.02,
      `"Avant taxes" rendu=${rendered} (${parsed}) doit valoir stored ${stored} − rabais ${discountSum} = ${expected.toFixed(2)}`,
    )

    // Sanity : la ligne Rabais reste visible (le fix ne doit pas la cacher)
    const itemsText = (await page.locator('[data-testid="facture-items"]').textContent()) || ''
    assert.match(itemsText, /Rabais/, 'la ligne "Rabais" doit toujours être visible')
  })
})
