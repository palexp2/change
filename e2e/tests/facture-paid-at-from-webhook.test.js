const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que l'API GET facture utilise paid_at / paid_amount / paid_charge_id
// (populés par le webhook invoice.paid) en priorité, sans flag unsynced.
describe('Facture — last_payment_in vient de paid_at quand dispo', () => {
  let browser, ctx, page, token, db
  let factureId
  let snapshot

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const f = db.prepare(`SELECT id, paid_at, paid_amount, paid_charge_id FROM factures WHERE invoice_id IS NOT NULL LIMIT 1`).get()
    if (!f) throw new Error('Aucune facture Stripe — impossible de tester')
    factureId = f.id
    snapshot = { paid_at: f.paid_at, paid_amount: f.paid_amount, paid_charge_id: f.paid_charge_id }

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    try {
      db.prepare('UPDATE factures SET paid_at=?, paid_amount=?, paid_charge_id=? WHERE id=?')
        .run(snapshot.paid_at, snapshot.paid_amount, snapshot.paid_charge_id, factureId)
    } catch {}
    db?.close()
    await browser?.close()
  })

  async function fetchFacture() {
    return page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: factureId })
  }

  test('paid_at présent → last_payment_in.received_at=paid_at, pas de flag unsynced', async () => {
    db.prepare('UPDATE factures SET paid_at=?, paid_amount=?, paid_charge_id=? WHERE id=?')
      .run('2026-04-15T10:30:00.000Z', 1234.56, 'ch_test_e2e', factureId)
    const f = await fetchFacture()
    assert.equal(f.last_payment_in?.received_at, '2026-04-15T10:30:00.000Z')
    assert.equal(f.last_payment_in?.method, 'stripe')
    assert.equal(f.last_payment_in?.amount, 1234.56)
    assert.ok(!f.last_payment_in?.unsynced, 'pas de flag unsynced quand paid_at présent')
  })
})
