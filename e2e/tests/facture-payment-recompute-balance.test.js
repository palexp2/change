// Regression : facture Stripe « open » payée hors Stripe (Interac) — après
// avoir POSTé le paiement, factures.balance_due doit retomber à 0 et le statut
// passer à « Payé ». Avant le fix, balance_due restait au montant de la
// facture parce que le webhook Stripe ignorait les paiements locaux.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')
const { randomUUID } = require('crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe('POST /api/payments — recompute factures.balance_due', () => {
  let browser, ctx, page, db, factureId, paymentId, companyId, token

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const co = db.prepare("SELECT id FROM companies ORDER BY created_at DESC LIMIT 1").get()
    if (!co) throw new Error('Aucune entreprise en base pour le test')
    companyId = co.id

    // Facture E2E avec solde dû — simule une facture Stripe "open" en retard.
    factureId = randomUUID()
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(`
      INSERT INTO factures (
        id, invoice_id, company_id, document_number, document_date, due_date,
        status, currency, amount_before_tax_cad, total_amount, balance_due,
        kind, sync_source, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      factureId,
      `__e2e_balance_${factureId}__`,
      companyId,
      `E2E-BAL-${factureId.slice(0, 8)}`,
      today,
      '2020-01-01', // due_date dépassée → status "En retard"
      'En retard',
      'CAD',
      59.00,
      61.95,
      61.95,
      'order',
      'E2E test'
    )

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    if (!token) throw new Error('Token introuvable après login')
  })

  after(async () => {
    // Cleanup obligatoire — supprime paiement + facture même si test failed.
    try {
      if (paymentId) db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId)
      db.prepare('DELETE FROM payments WHERE facture_id = ?').run(factureId)
      db.prepare('DELETE FROM factures WHERE id = ?').run(factureId)
    } catch {}
    try { db?.close() } catch {}
    try { await browser?.close() } catch {}
  })

  test('Après POST /api/payments, balance_due = 0 et status = "Payé"', async () => {
    // POST un paiement Interac complet sur la facture
    const res = await page.evaluate(async ({ factureId, token }) => {
      const r = await fetch('/erp/api/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facture_id: factureId,
          direction: 'in',
          method: 'interac',
          received_at: new Date().toISOString().slice(0, 10),
          amount: 61.95,
          currency: 'CAD',
          notes: 'E2E recompute balance test',
        }),
      })
      return { status: r.status, body: await r.json() }
    }, { factureId, token })

    assert.equal(res.status, 201, `POST /api/payments doit réussir (reçu: ${JSON.stringify(res.body)})`)
    paymentId = res.body?.payment?.id
    assert.ok(paymentId, 'payment.id doit être renvoyé')

    // La facture doit maintenant être recalculée
    const f = db.prepare('SELECT balance_due, status, paid_at FROM factures WHERE id = ?').get(factureId)
    assert.equal(Number(f.balance_due), 0, `balance_due doit retomber à 0 (reçu: ${f.balance_due})`)
    assert.equal(f.status, 'Payé', `status doit passer à "Payé" (reçu: ${f.status})`)
    // paid_at reste null — le helper ne le pose pas (Stripe le pose si Stripe paye).
    assert.equal(f.paid_at, null, 'paid_at reste null pour un paiement local hors Stripe')
  })

  test('Après DELETE du paiement, balance_due est restauré et status redevient "En retard"', async () => {
    assert.ok(paymentId, 'Le test précédent doit avoir créé le paiement')
    const res = await page.evaluate(async ({ paymentId, token }) => {
      const r = await fetch(`/erp/api/payments/${paymentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    }, { paymentId, token })

    assert.equal(res.status, 200, `DELETE /api/payments/:id doit réussir (reçu: ${JSON.stringify(res.body)})`)

    const f = db.prepare('SELECT balance_due, status FROM factures WHERE id = ?').get(factureId)
    assert.equal(Number(f.balance_due), 61.95, `balance_due doit revenir au total (reçu: ${f.balance_due})`)
    assert.equal(f.status, 'En retard', `status doit redevenir "En retard" (due_date passée) (reçu: ${f.status})`)
    paymentId = null // déjà supprimé, évite double-delete dans after()
  })
})
