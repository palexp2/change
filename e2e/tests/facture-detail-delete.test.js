// Vérifie que le bouton "Supprimer la facture" sur FactureDetail :
//  - Est visible pour un admin
//  - Affiche une modale de confirmation listant ce qui sera supprimé
//  - Supprime le record + cascade sur stripe_invoice_items
//  - Redirige vers /factures et le GET API renvoie 404 ensuite
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

describe('FactureDetail — bouton supprimer (admin only)', () => {
  let browser, ctx, page, db, factureId, itemId, companyId

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const co = db.prepare("SELECT id FROM companies WHERE name IS NOT NULL ORDER BY created_at DESC LIMIT 1").get()
    if (!co) throw new Error('Aucune entreprise en base pour le test')
    companyId = co.id

    factureId = randomUUID()
    db.prepare(
      `INSERT INTO factures (id, invoice_id, company_id, document_number, document_date,
          status, currency, amount_before_tax_cad, total_amount, balance_due, kind, sync_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      factureId, `__e2e_delete_inv_${factureId}__`, companyId,
      `E2E-DELETE-${factureId.slice(0, 8)}`, '2026-05-21',
      'Payé', 'CAD', 100, 114.98, 0, 'order', 'E2E test'
    )

    itemId = randomUUID()
    db.prepare(
      `INSERT INTO stripe_invoice_items (id, facture_id, stripe_invoice_id, stripe_line_id,
          description, quantity, unit_amount, amount, currency, proration)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(itemId, factureId, `__e2e_delete_inv_${factureId}__`, `__e2e_li_${itemId}__`,
      'E2E test item', 1, 10000, 10000, 'CAD', 0)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    try {
      // Filet de sécurité : si le test n'a pas réussi à supprimer via l'UI,
      // on nettoie en direct (sans toucher Stripe/QB — c'est juste un fixture).
      db.prepare('DELETE FROM stripe_invoice_items WHERE facture_id = ?').run(factureId)
      db.prepare('DELETE FROM factures WHERE id = ?').run(factureId)
    } catch {}
    try { db?.close() } catch {}
    try { await browser?.close() } catch {}
  })

  test('Le bouton supprime la facture + cascade stripe_invoice_items', async () => {
    await page.goto(URL + '/factures/' + factureId, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1', { timeout: 10000 })

    // Le bouton doit être visible pour un admin
    const deleteBtn = page.getByTestId('facture-delete-button')
    await deleteBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Clique → modale apparaît
    await deleteBtn.click()
    const confirmBtn = page.getByTestId('facture-delete-confirm')
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 })

    // La modale doit mentionner le numéro de facture et expliquer ce qui se passe
    const modalText = await page.locator('text=Ce qui sera supprimé').first().isVisible()
    assert.ok(modalText, 'Modale doit lister les side effects')

    // Confirme la suppression
    await confirmBtn.click()

    // Redirection vers /factures
    await page.waitForURL(u => /\/factures\/?$/.test(u.toString().replace(/\?.*$/, '')), { timeout: 10000 })

    // GET API renvoie 404 maintenant
    const status = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures/' + id, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.status
    }, factureId)
    assert.equal(status, 404, 'Facture doit être supprimée côté API')

    // La ligne stripe_invoice_items doit avoir été cascade-supprimée
    const itemStillThere = db.prepare('SELECT id FROM stripe_invoice_items WHERE id = ?').get(itemId)
    assert.equal(itemStillThere, undefined, 'stripe_invoice_items doit être cascade-supprimée')
  })
})
