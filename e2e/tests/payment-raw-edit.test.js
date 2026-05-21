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

// Vérifie l'expander « édition avancée » par paiement dans FacturePaymentsSection :
// un admin déplie une row payments, modifie la colonne `notes` via le panneau
// générique, et la valeur est persistée en DB.
//
// Un payment factice (notes="E2E …") est inséré avant le test et supprimé en
// cleanup — pas d'impact sur les rows réelles de la DB.
describe('FacturePayments — édition avancée par paiement', () => {
  let browser, ctx, page, db
  let factureId
  const paymentId = crypto.randomUUID()
  const initialNotes = `E2E init ${Date.now()}`
  const targetNotes = `E2E edited ${Date.now()}`

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

  test('l\'expander raw-edit est visible pour un admin', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const toggle = page.locator(`[data-testid="payment-raw-edit-toggle-${paymentId}"]`)
    await toggle.waitFor({ timeout: 5000 })
    assert.equal(await toggle.isVisible(), true)
  })

  test('déplier le payment expose les colonnes via le panneau générique', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.click(`[data-testid="payment-raw-edit-toggle-${paymentId}"]`)
    await page.waitForSelector(`[data-testid="payment-raw-edit-${paymentId}-input-notes"]`, { timeout: 5000 })
    await page.waitForSelector(`[data-testid="payment-raw-edit-${paymentId}-input-qb_deposit_id"]`, { timeout: 5000 })
    await page.waitForSelector(`[data-testid="payment-raw-edit-${paymentId}-input-direction"]`, { timeout: 5000 })
  })

  test('éditer la colonne notes persiste via autosave', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.click(`[data-testid="payment-raw-edit-toggle-${paymentId}"]`)
    const input = page.locator(`[data-testid="payment-raw-edit-${paymentId}-input-notes"]`)
    await input.waitFor({ timeout: 5000 })
    await input.fill(targetNotes)
    await input.blur()
    await page.waitForTimeout(800)
    const inDb = db.prepare('SELECT notes FROM payments WHERE id=?').get(paymentId)
    assert.equal(inDb.notes, targetNotes, `Notes attendues: ${targetNotes}, lues: ${inDb.notes}`)
  })
})
