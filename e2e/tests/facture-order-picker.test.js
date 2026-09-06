const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Picker Commande sur FactureDetail :
// - LinkedRecordField avec données filtrées par entreprise de la facture
// - Choisir une commande la persiste, retirer (×) la délie
// - Le picker n'apparaît pas tant qu'aucune entreprise n'est associée
describe('FactureDetail — picker commande (filtré par entreprise)', () => {
  let browser, ctx, page, token
  let factureId, originalCompanyId, originalOrderId
  let companyA, ordersA
  const FIELD = '[data-testid="linked-record-field-order_id"]'

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Trouver une facture liée à une entreprise qui a au moins une commande
    const target = await page.evaluate(async (tok) => {
      const factures = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      for (const f of (factures.data || [])) {
        if (!f.company_id || !f.invoice_id) continue
        const orders = await fetch(`/erp/api/orders?company_id=${f.company_id}&limit=all`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
        if ((orders.data || []).length > 0) return { facture: f, orders: orders.data }
      }
      return null
    }, token)
    assert.ok(target, 'une facture avec une entreprise et au moins une commande est requise')
    factureId = target.facture.id
    originalCompanyId = target.facture.company_id
    originalOrderId = target.facture.order_id
    companyA = originalCompanyId
    ordersA = target.orders
  })

  after(async () => {
    if (factureId) {
      await page.evaluate(async ({ tok, id, oid }) => {
        await fetch(`/erp/api/projets/factures/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: oid }),
        })
      }, { tok: token, id: factureId, oid: originalOrderId })
    }
    await browser?.close()
  })

  test('le picker offre uniquement les commandes de l\'entreprise', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 10000 })

    // Si une commande est déjà liée, on délie d'abord
    if (await field.getAttribute('data-state') === 'selected') {
      await field.locator('[data-testid="linked-record-clear"]').click()
      await page.waitForFunction(
        sel => document.querySelector(sel)?.getAttribute('data-state') === 'empty',
        FIELD,
        { timeout: 5000 }
      )
    }

    // Ouvrir le picker
    await field.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ timeout: 5000 })

    // Toutes les options du picker doivent appartenir à l'entreprise A
    const expectedNumbers = ordersA.map(o => `#${o.order_number}`).sort()
    const buttons = portal.locator('button').filter({ hasText: /^#\d+/ })
    const labels = (await buttons.allTextContents()).map(s => s.trim()).sort()
    // Comparer en sous-ensemble : le picker peut tronquer à 60 ; pour le test on vérifie qu'au moins
    // une partie des commandes attendues est présente et qu'aucune commande hors entreprise n'apparaît.
    const expectedSet = new Set(expectedNumbers)
    for (const l of labels) {
      assert.ok(expectedSet.has(l), `${l} ne fait pas partie des commandes de l'entreprise (${companyA})`)
    }
    assert.ok(labels.length > 0, 'au moins une commande doit être listée')
  })

  test('Sélection — chip + persistance en DB', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    if (await field.getAttribute('data-state') === 'selected') {
      await field.locator('[data-testid="linked-record-clear"]').click()
      await page.waitForFunction(
        sel => document.querySelector(sel)?.getAttribute('data-state') === 'empty',
        FIELD,
        { timeout: 5000 }
      )
    }
    await field.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ timeout: 5000 })
    const target = ordersA[0]
    await portal.locator('button', { hasText: `#${target.order_number}` }).first().click()
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'selected',
      FIELD,
      { timeout: 5000 }
    )
    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: factureId })
    assert.equal(fresh.order_id, target.id, `order_id en DB doit être ${target.id}`)
  })

  test('× délie + état vide en DB', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    await field.locator('[data-testid="linked-record-clear"]').click()
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'empty',
      FIELD,
      { timeout: 5000 }
    )
    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: factureId })
    assert.equal(fresh.order_id, null, 'order_id doit être null en DB')
  })
})
