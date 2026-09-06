const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
// better-sqlite3 est dans /server/node_modules — on y accède via require absolu
// puisque les e2e n'ont pas la dépendance directement.
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Ce test manipule directement la DB (sqlite) pour fixer l'état déféré sur une facture,
// car il n'y a pas d'endpoint pour activer artificiellement deferred_revenue_at sans
// passer par un push QB réel. Limité à l'environnement local.
describe('FactureDetail — affichage Revenu perçu d\'avance (3 états)', () => {
  let browser, ctx, page, db
  let factureId
  // Snapshot des champs originaux pour restauration
  let originalState = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Trouve une facture kind='order' qui a un envoi sur une commande liée (has_linked_shipment = 1).
    // Exclut les subscriptions : pour celles-ci, le bouton de constat n'est pas affiché
    // (constat fait à invoice.paid, pas à l'expédition).
    const fac = db.prepare(`
      SELECT f.id
      FROM factures f
      WHERE (f.kind = 'order' OR f.kind IS NULL)
        AND EXISTS (
          SELECT 1 FROM shipments sh
          LEFT JOIN orders od ON od.id = f.order_id
          LEFT JOIN orders op ON op.project_id = f.project_id AND f.project_id IS NOT NULL
          WHERE sh.order_id = od.id OR sh.order_id = op.id
        )
      LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture avec un envoi lié — impossible de tester ce flow')
    factureId = fac.id
    originalState = db.prepare(`
      SELECT deferred_revenue_at, deferred_revenue_amount_native, deferred_revenue_amount_cad,
             deferred_revenue_currency, revenue_recognized_at, revenue_recognized_je_id
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
          deferred_revenue_at = ?,
          deferred_revenue_amount_native = ?,
          deferred_revenue_amount_cad = ?,
          deferred_revenue_currency = ?,
          revenue_recognized_at = ?,
          revenue_recognized_je_id = ?
        WHERE id = ?
      `).run(
        originalState.deferred_revenue_at,
        originalState.deferred_revenue_amount_native,
        originalState.deferred_revenue_amount_cad,
        originalState.deferred_revenue_currency,
        originalState.revenue_recognized_at,
        originalState.revenue_recognized_je_id,
        factureId,
      )
    }
    db?.close()
    await browser?.close()
  })

  test('aucun badge dans le header si pas de deferred_revenue_at', async () => {
    db.prepare(`
      UPDATE factures SET deferred_revenue_at=NULL, deferred_revenue_amount_native=NULL,
        deferred_revenue_amount_cad=NULL, deferred_revenue_currency=NULL,
        revenue_recognized_at=NULL, revenue_recognized_je_id=NULL WHERE id=?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('[data-testid="revenue-status-deferred"]').count(), 0)
    assert.equal(await page.locator('[data-testid="revenue-status-recognized"]').count(), 0)
  })

  test('badge "Revenu perçu d\'avance" dans le header si déféré + envoi lié', async () => {
    db.prepare(`
      UPDATE factures SET
        deferred_revenue_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        deferred_revenue_amount_native = 100.00,
        deferred_revenue_amount_cad = 100.00,
        deferred_revenue_currency = 'CAD',
        revenue_recognized_at = NULL,
        revenue_recognized_je_id = NULL
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const badge = page.locator('[data-testid="revenue-status-deferred"]')
    await badge.waitFor({ timeout: 5000 })
    assert.match(await badge.innerText(), /Revenu perçu d.avance/)
    assert.equal(await page.locator('[data-testid="revenue-status-recognized"]').count(), 0)
    // Le bouton d'action est maintenant dans la section comptable, pas dans le header
    const accountingBtn = page.locator('[data-testid="facture-accounting-section"] [data-testid="accounting-recognize-btn"]')
    await accountingBtn.waitFor({ timeout: 5000 })
  })

  test('aucun badge dans le header si revenue_recognized_at (état visible dans la timeline)', async () => {
    db.prepare(`
      UPDATE factures SET
        revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = 'TEST-JE-1'
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // Le badge « Vente constatée » a été retiré du header — l'état est désormais
    // visible dans la section « Historique des événements » plus bas dans la page.
    assert.equal(await page.locator('[data-testid="revenue-status-recognized"]').count(), 0)
    // Le badge « Revenu perçu d'avance » non plus, puisque la vente est constatée.
    assert.equal(await page.locator('[data-testid="revenue-status-deferred"]').count(), 0)
    // Plus de bouton d'action quand déjà constatée
    assert.equal(await page.locator('[data-testid="accounting-recognize-btn"]').count(), 0)
  })

  test('endpoint recognize-revenue refuse si déjà constatée', async () => {
    // On choisit une condition de refus qui throw AVANT toute requête vers QuickBooks
    // (sinon le test poste une vraie JE en prod). « Vente déjà constatée » échoue
    // localement à postRevenueRecognitionJE — pas de qbPost, pas de side effect.
    db.prepare(`
      UPDATE factures SET
        revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = 'TEST-ALREADY-RECOGNIZED'
      WHERE id = ?
    `).run(factureId)
    const res = await page.evaluate(async ({ id }) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures/${id}/recognize-revenue`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      })
      return { status: r.status, body: await r.json() }
    }, { id: factureId })
    assert.equal(res.status, 400)
    assert.match(res.body.error || '', /déjà constatée/)
  })
})
