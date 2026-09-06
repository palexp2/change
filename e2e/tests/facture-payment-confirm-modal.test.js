// Vérifie que la saisie manuelle d'un paiement/remboursement de facture
// (FacturePaymentsSection) affiche une modale de confirmation des side effects
// AVANT de créer le payment et de pousser l'écriture QuickBooks — règle
// « confirmation des side effects » du CLAUDE.md.
//
// Couvre :
//  - clic "Enregistrer" ouvre la modale et NE crée PAS encore le payment
//  - la modale liste le mouvement monétaire + le push QB (Deposit) quand
//    skip_qb n'est pas coché
//  - Annuler ne crée rien
//  - cocher "écriture déjà postée" change le texte de la modale (aucune
//    écriture QB) et la confirmation crée bien le payment (qb_skipped)
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

describe('FacturePaymentsSection — modale de confirmation des side effects', () => {
  let browser, ctx, page, db, factureId, companyId, token

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const co = db.prepare("SELECT id FROM companies ORDER BY created_at DESC LIMIT 1").get()
    if (!co) throw new Error('Aucune entreprise en base pour le test')
    companyId = co.id

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
      `__e2e_confirm_${factureId}__`,
      companyId,
      `E2E-CONFIRM-${factureId.slice(0, 8)}`,
      today,
      today,
      'En retard',
      'CAD',
      100.00,
      114.98,
      114.98,
      'order',
      'E2E test',
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
    // Tout payment créé pendant le test (même résiduel après échec) est supprimé,
    // puis la facture jetable. Aucune config existante n'est touchée.
    try { db.prepare('DELETE FROM payments WHERE facture_id = ?').run(factureId) } catch {}
    try { db.prepare('DELETE FROM factures WHERE id = ?').run(factureId) } catch {}
    try { db?.close() } catch {}
    try { await browser?.close() } catch {}
  })

  test('clic "Enregistrer" ouvre la modale, liste le Deposit QB, et ne crée PAS le payment', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })

    // Ouvre le formulaire de paiement reçu (hors Stripe).
    await page.locator('[data-testid="add-payment-in"]').click()
    await page.locator('[data-testid="payment-amount"]').fill('114.98')

    // skip_qb laissé décoché → l'écriture QB serait postée.
    await page.locator('[data-testid="payment-submit"]').click()

    // La modale de confirmation s'affiche.
    const body = page.locator('[data-testid="payment-confirm-body"]')
    await body.waitFor({ timeout: 5000 })
    assert.equal(await body.isVisible(), true, 'la modale de confirmation doit être visible')

    const bodyText = await body.innerText()
    assert.match(bodyText, /paiement reçu/i, 'la modale doit mentionner le mouvement monétaire')
    assert.match(bodyText, /114,98/, 'la modale doit afficher le montant formaté')
    assert.match(bodyText, /Deposit/, 'la modale doit annoncer le Deposit QuickBooks')
    assert.match(bodyText, /QuickBooks/i, 'la modale doit mentionner QuickBooks')

    // Tant qu'on n'a pas confirmé, AUCUN payment n'est créé.
    const countBefore = db.prepare('SELECT COUNT(*) c FROM payments WHERE facture_id = ?').get(factureId).c
    assert.equal(countBefore, 0, 'aucun payment ne doit exister avant confirmation')

    // Annuler referme la modale sans rien créer.
    await page.locator('[data-testid="payment-confirm-body"]').waitFor()
    await page.getByRole('button', { name: 'Annuler' }).last().click()
    await page.waitForTimeout(300)
    const countAfterCancel = db.prepare('SELECT COUNT(*) c FROM payments WHERE facture_id = ?').get(factureId).c
    assert.equal(countAfterCancel, 0, 'Annuler ne doit créer aucun payment')
  })

  test('cocher "écriture déjà postée" change le texte (aucune écriture QB) et la confirmation crée le payment', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })

    await page.locator('[data-testid="add-payment-in"]').click()
    await page.locator('[data-testid="payment-amount"]').fill('114.98')
    // Coche skip_qb → aucune écriture QB ne sera postée.
    await page.locator('[data-testid="payment-skip-qb"]').check()
    await page.locator('[data-testid="payment-submit"]').click()

    const body = page.locator('[data-testid="payment-confirm-body"]')
    await body.waitFor({ timeout: 5000 })
    const bodyText = await body.innerText()
    assert.match(bodyText, /Aucune écriture/i, 'la modale doit indiquer qu\'aucune écriture QB ne sera postée')
    assert.doesNotMatch(bodyText, /Deposit/, 'la modale ne doit pas annoncer de Deposit quand skip_qb est coché')

    // Confirme → le payment est créé (qb_skipped, pas de push QB).
    await page.locator('[data-testid="payment-confirm-submit"]').click()

    // La row apparaît en DB.
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="payment-confirm-body"]'),
      { timeout: 5000 },
    )
    await page.waitForTimeout(500)
    const row = db.prepare('SELECT method, amount, qb_skipped, qb_deposit_id FROM payments WHERE facture_id = ?').get(factureId)
    assert.ok(row, 'le payment doit être créé après confirmation')
    assert.equal(Number(row.amount), 114.98)
    assert.equal(row.qb_skipped, 1, 'qb_skipped doit être à 1')
    assert.equal(row.qb_deposit_id, null, 'aucun Deposit QB ne doit être posé')
  })
})
