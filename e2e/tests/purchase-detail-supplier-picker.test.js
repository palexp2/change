const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie la règle FK (CLAUDE.md) sur le champ Fournisseur de PurchaseDetail :
// un picker recherchable permet de SÉLECTIONNER/lier une company existante, et le
// record lié s'affiche en lien cliquable (NAVIGATION).
describe('PurchaseDetail — picker FK Fournisseur (company)', () => {
  let browser, ctx, page
  let purchaseId
  let original = {}   // { supplier_company_id, supplier }
  let targetCompany   // { id, name } choisie dans le picker

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const picked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const data = await fetch('/erp/api/purchases?limit=50&page=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const list = data.data || data
      const first = (list || [])[0]
      const companies = await fetch('/erp/api/companies/lookup', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      // Choisit une company au nom non vide ET UNIQUE dans la liste, pour que le
      // filtre live du picker la renvoie sans ambiguïté (sélection déterministe).
      const counts = {}
      for (const c of (companies || [])) { const n = (c.name || '').trim(); if (n) counts[n] = (counts[n] || 0) + 1 }
      const company = (companies || []).find(c => {
        const n = (c.name || '').trim()
        return n.length >= 4 && counts[n] === 1 && c.id !== (first?.supplier_company_id ?? null)
      })
      if (!first || !company) return null
      return {
        purchase: { id: first.id, supplier_company_id: first.supplier_company_id ?? null, supplier: first.supplier ?? null },
        company: { id: company.id, name: company.name },
      }
    })
    assert.ok(picked, 'besoin d\'un achat existant et d\'au moins une entreprise')
    purchaseId = picked.purchase.id
    original = picked.purchase
    targetCompany = picked.company
  })

  after(async () => {
    // Restaure toujours la valeur d'origine (champ existant écrasé, pas un record créé).
    if (purchaseId && page) {
      await page.evaluate(async ({ id, orig }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/purchases/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplier_company_id: orig.supplier_company_id, supplier: orig.supplier }),
        })
      }, { id: purchaseId, orig: original })
    }
    await browser?.close()
  })

  test('le picker recherchable lie une company → supplier_company_id persisté + lien cliquable', async () => {
    await page.goto(`${URL}/purchases/${purchaseId}`, { waitUntil: 'domcontentloaded' })

    // Le picker (SearchableSelect) doit être rendu, peu importe que la company soit déjà liée ou non.
    const trigger = page.getByTestId('purchase-supplier-company')
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    await trigger.click()

    const menu = page.getByTestId('purchase-supplier-company-menu')
    await menu.waitFor({ state: 'visible', timeout: 5000 })

    // Recherche live puis sélection de la company cible (texte exact → déterministe).
    await menu.locator('input').fill(targetCompany.name)
    await page.waitForTimeout(200)
    await menu.getByText(targetCompany.name, { exact: true }).first().click()

    // Persistance côté serveur.
    await page.waitForTimeout(800)
    const confirmed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).supplier_company_id
    }, { id: purchaseId })
    assert.strictEqual(confirmed, targetCompany.id, `supplier_company_id doit être persisté après sélection (got=${confirmed}, want=${targetCompany.id}, name=${targetCompany.name})`)

    // Affordance NAVIGATION : un lien cliquable vers /companies/<id> apparaît.
    const link = page.locator(`a[href*="/companies/${targetCompany.id}"]`)
    await link.first().waitFor({ state: 'visible', timeout: 5000 })
    assert.ok(await link.count() > 0, 'le record lié doit s\'afficher en lien cliquable')
  })
})
