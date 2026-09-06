const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('PurchaseDetail — autosave', () => {
  let browser, ctx, page
  let purchaseId
  let originals = {}

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const pick = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const data = await fetch('/erp/api/purchases?limit=50&page=1', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const list = data.data || data
      const first = list[0]
      if (!first) return null
      return {
        id: first.id,
        status: first.status,
        qty_received: first.qty_received,
        notes: first.notes,
      }
    })
    assert.ok(pick, 'besoin d\'un achat existant')
    purchaseId = pick.id
    originals = pick
  })

  after(async () => {
    // restore
    if (purchaseId) {
      await page.evaluate(async ({ id, orig }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/purchases/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: orig.status,
            qty_received: orig.qty_received,
            notes: orig.notes,
          }),
        })
      }, { id: purchaseId, orig: originals })
    }
    await browser?.close()
  })

  test('PATCH /api/purchases/:id met à jour seulement les champs fournis', async () => {
    const result = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const before = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const patch = await fetch(`/erp/api/purchases/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Reçu partiellement', qty_received: 42 }),
      })
      const after = await patch.json()
      return { before, after, status: patch.status }
    }, { id: purchaseId })

    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.after.status, 'Reçu partiellement')
    assert.strictEqual(result.after.qty_received, 42)
    // Les autres champs doivent être inchangés
    assert.strictEqual(result.after.qty_ordered, result.before.qty_ordered)
    assert.strictEqual(result.after.reference, result.before.reference)
    assert.strictEqual(result.after.product_id, result.before.product_id)
  })

  test('PATCH ignore les clés non whitelistées (product_id, id, ...)', async () => {
    const result = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const before = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const r = await fetch(`/erp/api/purchases/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: 'should-not-change', status: 'Reçu' }),
      })
      const after = await r.json()
      return { status: r.status, after, before }
    }, { id: purchaseId })

    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.after.status, 'Reçu')
    assert.strictEqual(result.after.product_id, result.before.product_id, 'product_id ne doit pas changer')
  })

  test('autosave UI — changer le statut via le select persiste', async () => {
    await page.goto(`${URL}/purchases/${purchaseId}`, { waitUntil: 'domcontentloaded' })
    // attendre que le select statut soit rendu
    const statusSelect = page.locator('select').first()
    await statusSelect.waitFor({ timeout: 10000 })

    // Choisir "Annulé" (valeur improbable → témoin)
    await statusSelect.selectOption('Annulé')

    // Laisser le temps au fetch de se terminer
    await page.waitForTimeout(800)

    const confirmed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).status
    }, { id: purchaseId })
    assert.strictEqual(confirmed, 'Annulé', 'changement de statut doit être persisté')
  })
})
