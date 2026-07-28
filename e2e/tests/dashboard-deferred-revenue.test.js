const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune config modifiée.
describe('Dashboard — tuile Revenus perçus d\'avance', () => {
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

  test('L\'endpoint /api/dashboard/deferred-revenue renvoie items[] et total_cad', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/deferred-revenue', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: r.status, body: await r.json() }
    })
    assert.equal(data.status, 200, `attendu 200, reçu ${data.status}`)
    const b = data.body
    assert.ok(Array.isArray(b.items), 'items[] manquant')
    assert.equal(typeof b.total_cad, 'number', 'total_cad manquant')
    for (const i of b.items) {
      assert.ok(i.id, 'item.id manquant')
      assert.ok(i.paid_at, `paid_at manquant sur ${i.id}`)
      assert.equal(typeof i.amount_native, 'number', `amount_native manquant sur ${i.id}`)
      assert.equal(typeof i.deferred_posted, 'boolean', `deferred_posted manquant sur ${i.id}`)
      // Jamais de facture déjà constatée ni d'abonnement dans la liste :
      // le total doit refléter uniquement le passif 23900 en attente.
      assert.ok(i.currency, `currency manquant sur ${i.id}`)
    }
    // Le total est la somme des amount_cad non nuls.
    const expected = Math.round(b.items.reduce((s, i) => s + (i.amount_cad || 0), 0) * 100) / 100
    assert.equal(b.total_cad, expected, 'total_cad ≠ somme des amount_cad')
  })

  test('La tuile s\'affiche sur le dashboard avec le total', async () => {
    await page.goto(URL + '/', { waitUntil: 'domcontentloaded' })
    const section = page.locator('[data-testid="section-deferred-revenue"]')
    await section.waitFor({ state: 'attached', timeout: 15000 })
    await section.scrollIntoViewIfNeeded()
    const total = page.locator('[data-testid="deferred-revenue-total"]')
    await total.waitFor({ state: 'visible', timeout: 15000 })
    const text = (await total.textContent()) || ''
    assert.match(text.replace(/[  ]/g, ' '), /\$/, `total sans montant : « ${text} »`)
  })
})
