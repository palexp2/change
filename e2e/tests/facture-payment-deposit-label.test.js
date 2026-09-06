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

// Vérifie que les paiements hors Stripe affichent leur écriture QB comme
// "DEP #<id>" (Deposit) plutôt que "JE #<id>" (Journal Entry) — l'écriture
// comptable hors-Stripe est maintenant un QB Deposit.
//
// Le test n'appelle PAS l'API QuickBooks : il insère directement une row
// payments avec qb_deposit_id pré-rempli, puis vérifie le rendu UI. La row
// est supprimée dans le hook after().
describe('FacturePayments — paiement hors Stripe affiché en Deposit', () => {
  let browser, ctx, page, db
  let factureId
  const paymentId = crypto.randomUUID()
  const fakeDepositId = `E2E-DEP-${Date.now()}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Sélectionne une facture existante (n'importe laquelle, on n'agit que sur
    // une row payments transitoire qu'on supprime en cleanup).
    const fac = db.prepare(`
      SELECT id FROM factures
      WHERE total_amount > 0 AND status IS NOT 'Brouillon'
      ORDER BY document_date DESC LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture trouvée pour le test')
    factureId = fac.id

    db.prepare(`
      INSERT INTO payments (
        id, facture_id, direction, method, received_at, amount, currency,
        qb_deposit_id, notes
      ) VALUES (?, ?, 'in', 'cheque', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 123.45, 'CAD', ?, ?)
    `).run(paymentId, factureId, fakeDepositId, `E2E test ${Date.now()}`)

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
    // Cleanup obligatoire — la row factice doit disparaître même si le test échoue.
    if (paymentId) {
      try { db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('le tag "DEP #<id>" apparaît dans la colonne QB des paiements', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // L'élément peut être un <a> (si realm QB connu) ou un <span> (si pas d'URL).
    const tagLocator = page.getByText(`DEP #${fakeDepositId}`, { exact: false }).first()
    await tagLocator.waitFor({ timeout: 5000 })
    const txt = await tagLocator.textContent()
    assert.ok(txt && txt.includes('DEP'), `Le tag QB doit contenir "DEP" (reçu: ${txt})`)
    assert.ok(txt && txt.includes(fakeDepositId), `Le tag QB doit inclure ${fakeDepositId}`)
  })

  test('l\'en-tête de colonne s\'appelle "QB"', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    // L'en-tête est dans le bloc Paiements et remboursements. On cible le th
    // de cette zone — un <th> qui contient exactement "QB" en MAJUSCULES (via
    // CSS uppercase, le DOM contient encore "QB" tel quel).
    const header = page.locator('th', { hasText: /^QB$/ }).first()
    await header.waitFor({ timeout: 5000 })
    assert.equal(await header.isVisible(), true)
  })
})
