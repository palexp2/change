const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Garde-fou contre la régression où un même remboursement Stripe s'affichait
// en double : une ligne héritée d'Airtable (invoice_id = ch_xxx, charge parent)
// + une ligne native (invoice_id = re_xxx) créées séparément. Le backfill
// durci dans services/stripe.js dedupe désormais sur le charge_id parent
// extrait du raw du balance_transaction et fusionne les paires existantes.
describe('Remboursements Stripe — pas de doublons côté factures', () => {
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

  test('aucune paire (ch_xxx, re_xxx) en factures pour le même refund', async () => {
    const data = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      return json.data || []
    })

    const remb = data.filter(f => f.sync_source === 'Remboursements Stripe')
    assert.ok(remb.length > 0, 'au moins un remboursement Stripe attendu pour valider')

    // Construit l'index par charge_id parent : un re_xxx Stripe partage le
    // suffixe avec son ch_xxx parent (ex. re_3T5t32EO… ↔ ch_3T5t32EO…).
    // On compare la clé `3T5t32EO…` extraite après le préfixe.
    const stripeIdSuffix = (s) => s ? s.replace(/^(re_|ch_|pyr_|py_)/, '') : null
    const groups = new Map()
    for (const f of remb) {
      const k = stripeIdSuffix(f.invoice_id)
      if (!k) continue
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push({ id: f.id, invoice_id: f.invoice_id, airtable_id: f.airtable_id })
    }

    const dups = [...groups.entries()].filter(([, rows]) => rows.length > 1)
    if (dups.length > 0) {
      console.error('Doublons détectés :')
      for (const [k, rows] of dups) console.error(` clé=${k}:`, rows)
    }
    assert.equal(dups.length, 0, `${dups.length} doublon(s) restant(s) — cf. console`)
  })
})
