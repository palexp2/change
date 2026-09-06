const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le bouton « Lier JE existante » + « Lier revenu différé » dans la
// section Historique des événements. On ne valide jamais un vrai ID QB :
// soumettre un ID bidon doit retourner une erreur claire (404 côté QB).
describe('FactureAccountingSection — liens manuels vers transactions QB existantes', () => {
  let browser, ctx, page, db
  let factureId
  let originalState = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    const fac = db.prepare(`
      SELECT id FROM factures
      WHERE (kind = 'order' OR kind IS NULL)
        AND amount_before_tax_cad IS NOT NULL
        AND amount_before_tax_cad > 0
      LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture kind=order avec montant — impossible de tester')
    factureId = fac.id
    originalState = db.prepare(`
      SELECT revenue_recognized_at, revenue_recognized_je_id,
             deferred_revenue_at, deferred_revenue_qb_ref,
             deferred_revenue_amount_native, deferred_revenue_amount_cad,
             deferred_revenue_currency
      FROM factures WHERE id = ?
    `).get(factureId)

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
    if (factureId && originalState) {
      db.prepare(`
        UPDATE factures SET
          revenue_recognized_at = ?,
          revenue_recognized_je_id = ?,
          deferred_revenue_at = ?,
          deferred_revenue_qb_ref = ?,
          deferred_revenue_amount_native = ?,
          deferred_revenue_amount_cad = ?,
          deferred_revenue_currency = ?
        WHERE id = ?
      `).run(
        originalState.revenue_recognized_at,
        originalState.revenue_recognized_je_id,
        originalState.deferred_revenue_at,
        originalState.deferred_revenue_qb_ref,
        originalState.deferred_revenue_amount_native,
        originalState.deferred_revenue_amount_cad,
        originalState.deferred_revenue_currency,
        factureId,
      )
    }
    db?.close()
    await browser?.close()
  })

  test('boutons « Lier JE existante » et « Lier revenu différé » visibles quand non posés', async () => {
    db.prepare(`
      UPDATE factures SET
        revenue_recognized_at = NULL, revenue_recognized_je_id = NULL,
        deferred_revenue_at = NULL, deferred_revenue_qb_ref = NULL,
        deferred_revenue_amount_native = NULL, deferred_revenue_amount_cad = NULL,
        deferred_revenue_currency = NULL
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const section = page.locator('[data-testid="facture-accounting-section"]')
    await section.waitFor({ timeout: 5000 })
    await section.locator('[data-testid="accounting-link-recognized-btn"]').waitFor({ timeout: 5000 })
    await section.locator('[data-testid="accounting-link-deferred-btn"]').waitFor({ timeout: 5000 })
  })

  test('soumettre un ID bidon pour JE → erreur visible, rien posé en DB', async () => {
    db.prepare(`
      UPDATE factures SET revenue_recognized_at = NULL, revenue_recognized_je_id = NULL
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="accounting-link-recognized-btn"]').click()
    await page.locator('[data-testid="link-qb-id-input"]').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="link-qb-id-input"]').fill('99999999999')
    await page.locator('[data-testid="link-qb-confirm-btn"]').click()
    await page.locator('[data-testid="link-modal-error"]').waitFor({ timeout: 15000 })
    const errText = await page.locator('[data-testid="link-modal-error"]').textContent()
    assert.match(errText, /introuvable|404|invalid|Erreur QB/i)
    const fresh = db.prepare('SELECT revenue_recognized_at, revenue_recognized_je_id FROM factures WHERE id=?').get(factureId)
    assert.equal(fresh.revenue_recognized_at, null)
    assert.equal(fresh.revenue_recognized_je_id, null)
    // Fermer la modale
    await page.locator('button:has-text("Annuler")').click()
  })

  test('boutons cachés quand les colonnes sont déjà posées', async () => {
    db.prepare(`
      UPDATE factures SET
        revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = 'TEST-LINK-1',
        deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        deferred_revenue_qb_ref = 'deposit:TEST-LINK-1',
        deferred_revenue_amount_native = 100, deferred_revenue_amount_cad = 100,
        deferred_revenue_currency = 'CAD'
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="facture-accounting-section"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator('[data-testid="accounting-link-recognized-btn"]').count(), 0)
    assert.equal(await page.locator('[data-testid="accounting-link-deferred-btn"]').count(), 0)
  })
})
