const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le bouton « Constater manuellement » dans la section « Historique des événements »
// (3e ligne « Vente constatée »). On manipule la DB pour fixer revenue_recognized_at
// et observer la visibilité du bouton + la modale de confirmation. On ne clique JAMAIS
// « Confirmer » : ça poste une JE réelle dans QuickBooks production.
describe('FactureAccountingSection — bouton « Constater la vente »', () => {
  let browser, ctx, page, db
  let factureId
  let originalState = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // N'importe quelle facture kind='order' avec un montant — le bouton est censé
    // être visible même sans envoi lié (bypass côté serveur).
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
      SELECT revenue_recognized_at, revenue_recognized_je_id
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
    // Restauration explicite — le test écrase un champ existant (revenue_recognized_at).
    if (factureId && originalState) {
      db.prepare(`
        UPDATE factures SET revenue_recognized_at = ?, revenue_recognized_je_id = ?
        WHERE id = ?
      `).run(originalState.revenue_recognized_at, originalState.revenue_recognized_je_id, factureId)
    }
    db?.close()
    await browser?.close()
  })

  test('bouton visible dans la section comptable quand non constatée', async () => {
    db.prepare(`UPDATE factures SET revenue_recognized_at=NULL, revenue_recognized_je_id=NULL WHERE id=?`).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // Le bouton doit être dans la section comptable, pas dans le header
    const section = page.locator('[data-testid="facture-accounting-section"]')
    await section.waitFor({ timeout: 5000 })
    const btn = section.locator('[data-testid="accounting-recognize-btn"]')
    await btn.waitFor({ timeout: 5000 })
    assert.match(await btn.innerText(), /Constater manuellement/)
    // Vérifie que le header n'a plus ni l'ancien bouton auto ni le manuel
    assert.equal(await page.locator('[data-testid="revenue-recognize-btn"]').count(), 0)
    assert.equal(await page.locator('[data-testid="revenue-recognize-manual-btn"]').count(), 0)
  })

  test('clic ouvre une modale listant les side effects', async () => {
    db.prepare(`UPDATE factures SET revenue_recognized_at=NULL, revenue_recognized_je_id=NULL WHERE id=?`).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="accounting-recognize-btn"]').click()
    const confirmBtn = page.locator('[data-testid="accounting-recognize-confirm"]')
    await confirmBtn.waitFor({ timeout: 5000 })
    const modalText = await page.locator('text=Cette action déclenchera les opérations suivantes').textContent()
    assert.match(modalText, /opérations suivantes/)
    assert.equal(await page.locator('text=Journal Entry').count() > 0, true)
    assert.equal(await page.locator('text=40000 Ventes').count() > 0, true)
    // Annuler ferme sans appeler l'API
    await page.locator('button:has-text("Annuler")').click()
    await confirmBtn.waitFor({ state: 'detached', timeout: 5000 })
    const fresh = db.prepare(`SELECT revenue_recognized_at FROM factures WHERE id=?`).get(factureId)
    assert.equal(fresh.revenue_recognized_at, null)
  })

  test('bouton caché quand déjà constatée', async () => {
    db.prepare(`
      UPDATE factures SET
        revenue_recognized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        revenue_recognized_je_id = 'TEST-MANUAL-1'
      WHERE id = ?
    `).run(factureId)
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // Bouton absent dans la section comptable (le badge « Vente constatée » a été
    // retiré du header — l'état est désormais visible dans l'historique des événements).
    assert.equal(await page.locator('[data-testid="accounting-recognize-btn"]').count(), 0)
  })
})
