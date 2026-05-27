const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')
const crypto = require('node:crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// L'expander « édition avancée » par paiement/remboursement a été retiré de
// FacturePaymentsSection. Ce test vérifie que le toggle n'est plus rendu,
// y compris pour un admin, même quand une row payments existe.
describe('FacturePayments — édition avancée par paiement (retirée)', () => {
  let browser, ctx, page, db
  let factureId
  const paymentId = crypto.randomUUID()
  const initialNotes = `E2E init ${Date.now()}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const fac = db.prepare(`
      SELECT id FROM factures
      WHERE total_amount > 0 AND status IS NOT 'Brouillon'
      ORDER BY document_date DESC LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture disponible')
    factureId = fac.id

    db.prepare(`
      INSERT INTO payments (
        id, facture_id, direction, method, received_at, amount, currency, notes
      ) VALUES (?, ?, 'in', 'cheque', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 50.00, 'CAD', ?)
    `).run(paymentId, factureId, initialNotes)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    if (paymentId) {
      try { db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('le toggle raw-edit n\'est plus rendu sur la fiche facture', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // S'assure que la section paiements a chargé : le montant inséré apparaît.
    await page.waitForSelector('text=50,00', { timeout: 10000 })
    const toggle = page.locator(`[data-testid="payment-raw-edit-toggle-${paymentId}"]`)
    assert.equal(await toggle.count(), 0, 'Le toggle d\'édition avancée par paiement devrait avoir disparu')
  })
})
