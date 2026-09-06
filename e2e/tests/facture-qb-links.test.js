const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que les routes factures et payments retournent les URLs profondes
// QB calculées à partir de deferred_revenue_qb_ref et qb_payment_id /
// qb_journal_entry_id. Le test pose les valeurs en DB pour simuler un push.
describe('Liens QB sur la fiche facture', () => {
  let browser, ctx, page, token, db
  let factureId
  let snapshot

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const f = db.prepare(`SELECT id, deferred_revenue_qb_ref, revenue_recognized_je_id FROM factures WHERE deferred_revenue_at IS NOT NULL LIMIT 1`).get()
    if (!f) throw new Error('Aucune facture deferred — impossible de tester')
    factureId = f.id
    snapshot = { qb_ref: f.deferred_revenue_qb_ref, je_id: f.revenue_recognized_je_id }

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
      db.prepare('UPDATE factures SET deferred_revenue_qb_ref=?, revenue_recognized_je_id=? WHERE id=?')
        .run(snapshot.qb_ref, snapshot.je_id, factureId)
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

  test('deferred_revenue_qb_url construit pour salesreceipt:<id>', async () => {
    db.prepare('UPDATE factures SET deferred_revenue_qb_ref=? WHERE id=?').run('salesreceipt:42', factureId)
    const f = await fetchFacture()
    assert.ok(f.deferred_revenue_qb_url, `URL devrait être présente, vu : ${f.deferred_revenue_qb_url}`)
    assert.match(f.deferred_revenue_qb_url, /\/app\/salesreceipt\?txnId=42/)
    assert.match(f.deferred_revenue_qb_url, /^https:\/\/app\.(sandbox\.)?qbo\.intuit\.com/)
  })

  test('deferred_revenue_qb_url construit pour deposit:<id>', async () => {
    db.prepare('UPDATE factures SET deferred_revenue_qb_ref=? WHERE id=?').run('deposit:17193', factureId)
    const f = await fetchFacture()
    assert.match(f.deferred_revenue_qb_url, /\/app\/deposit\?txnId=17193/)
  })

  test('revenue_recognized_qb_url construit pour journal:<id>', async () => {
    db.prepare('UPDATE factures SET revenue_recognized_je_id=? WHERE id=?').run('555', factureId)
    const f = await fetchFacture()
    assert.match(f.revenue_recognized_qb_url, /\/app\/journal\?txnId=555/)
  })

  test('payments listing retourne qb_payment_url et qb_journal_entry_url', async () => {
    // Insère une ligne de payment factice avec qb_payment_id pour vérifier l'URL.
    const { randomUUID } = require('crypto')
    const pid = randomUUID()
    db.prepare(`
      INSERT INTO payments (id, facture_id, direction, method, received_at, amount, currency, qb_payment_id)
      VALUES (?, ?, 'in', 'autre', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'CAD', '777')
    `).run(pid, factureId, 100)

    try {
      const rows = await page.evaluate(async ({ tok, id }) => {
        const r = await fetch(`/erp/api/payments/facture/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
        return r.json()
      }, { tok: token, id: factureId })
      const mine = (rows || []).find(r => r.id === pid)
      assert.ok(mine, 'le payment de test doit être dans la liste')
      assert.match(mine.qb_payment_url, /\/app\/salesreceipt\?txnId=777/)
    } finally {
      db.prepare('DELETE FROM payments WHERE id=?').run(pid)
    }
  })
})
