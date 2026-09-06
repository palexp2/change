const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Fiche reçu — édition du Total des taxes (répartition au prorata)', () => {
  let browser, ctx, page
  let receiptId = null
  let original = null // { tps, tvq, other_taxes } à restaurer (on édite un reçu existant)

  async function getTaxes(id) {
    return page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const x = await r.json()
      return { tps: x.tps || 0, tvq: x.tvq || 0, other_taxes: x.other_taxes || 0 }
    }, id)
  }

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
      const r = await fetch('/erp/api/sale-receipts?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const list = (await r.json()).data || []
      const c = list.find(x => x.status === 'done' && (x.tps || 0) > 0 && (x.tvq || 0) > 0)
      return c ? { id: c.id, tps: c.tps, tvq: c.tvq, other_taxes: c.other_taxes || 0 } : null
    })
    assert.ok(picked, 'aucun reçu done avec TPS et TVQ disponible')
    receiptId = picked.id
    original = { tps: picked.tps, tvq: picked.tvq, other_taxes: picked.other_taxes }
  })

  after(async () => {
    // Restaure toujours les taxes d'origine (on a modifié un reçu existant).
    if (page && receiptId && original) {
      await page.evaluate(async ({ id, vals }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/sale-receipts/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(vals),
        })
      }, { id: receiptId, vals: original })
    }
    await browser?.close()
  })

  test('modifier le total des taxes répartit au prorata sur TPS / TVQ', async () => {
    await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })
    const cell = page.locator('[data-testid="receipt-total-taxes"]')
    await cell.waitFor({ state: 'visible', timeout: 10000 })

    const oldTotal = Math.round((original.tps + original.tvq + original.other_taxes) * 100) / 100
    // Nouveau total = double de l'ancien — les proportions doivent être conservées.
    const newTotal = Math.round(oldTotal * 2 * 100) / 100

    await cell.fill(String(newTotal))
    await cell.blur()

    // Attendre la persistance (somme == newTotal)
    await page.waitForFunction(async ({ id, expected }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/sale-receipts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const x = await r.json()
      const sum = Math.round(((x.tps || 0) + (x.tvq || 0) + (x.other_taxes || 0)) * 100) / 100
      return Math.abs(sum - expected) < 0.01
    }, { id: receiptId, expected: newTotal }, { timeout: 5000 })

    const after = await getTaxes(receiptId)
    const sum = Math.round((after.tps + after.tvq + after.other_taxes) * 100) / 100

    // 1) La somme correspond exactement au total saisi
    assert.ok(Math.abs(sum - newTotal) < 0.01, `somme ${sum} ≠ total saisi ${newTotal}`)

    // 2) Les proportions TPS/TVQ sont conservées (ratio identique à ±1 %)
    const oldRatio = original.tps / original.tvq
    const newRatio = after.tps / after.tvq
    assert.ok(Math.abs(newRatio - oldRatio) / oldRatio < 0.01, `ratio TPS/TVQ non conservé : ${oldRatio} → ${newRatio}`)

    // 3) Concrètement, chaque taxe a doublé (à un cent près pour l'arrondi)
    assert.ok(Math.abs(after.tps - original.tps * 2) <= 0.02, `TPS attendue ~${original.tps * 2}, got ${after.tps}`)
    assert.ok(Math.abs(after.tvq - original.tvq * 2) <= 0.02, `TVQ attendue ~${original.tvq * 2}, got ${after.tvq}`)
  })
})
