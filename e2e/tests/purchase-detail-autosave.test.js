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
        emplacement: first.emplacement,
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
          body: JSON.stringify({ emplacement: orig.emplacement }),
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
        body: JSON.stringify({ emplacement: 'E2E-AUTOSAVE' }),
      })
      const after = await patch.json()
      return { before, after, status: patch.status }
    }, { id: purchaseId })

    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.after.emplacement, 'E2E-AUTOSAVE')
    // Les autres champs doivent être inchangés. `supplier_company_id` est la
    // dernière colonne native modifiable à côté de l'emplacement : produit,
    // référence, dates, quantités, prix et notes ont été droppés (migrations
    // 035 et 036 pour « Qté reçue »).
    assert.strictEqual(result.after.supplier_company_id, result.before.supplier_company_id)
    assert.strictEqual(result.after.airtable_id, result.before.airtable_id)
  })

  test('PATCH ignore les clés non whitelistées (qty_received droppé, id, ...)', async () => {
    const result = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const before = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const r = await fetch(`/erp/api/purchases/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty_received: 42, emplacement: 'E2E-WHITELIST' }),
      })
      const after = await r.json()
      return { status: r.status, after, before }
    }, { id: purchaseId })

    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.after.emplacement, 'E2E-WHITELIST')
    assert.ok(!('qty_received' in result.after), 'la colonne « Qté reçue » n\'existe plus (migration 036)')
  })

  // Le champ témoin était « Statut » (select) jusqu'à sa suppression — colonne
  // droppée (migration 032). On pilote désormais « Emplacement », un texte
  // autosauvegardé au blur par le même chemin.
  test('autosave UI — changer l\'emplacement persiste', async () => {
    await page.goto(`${URL}/purchases/${purchaseId}`, { waitUntil: 'domcontentloaded' })
    const input = page.locator('[data-field-key="emplacement"] input')
    await input.waitFor({ timeout: 10000 })

    await input.fill('E2E-UI-AUTOSAVE')
    await input.blur()

    // Laisser le temps au fetch de se terminer
    await page.waitForTimeout(800)

    const confirmed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/purchases/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).emplacement
    }, { id: purchaseId })
    assert.strictEqual(confirmed, 'E2E-UI-AUTOSAVE', "changement d'emplacement doit être persisté")
  })
})
