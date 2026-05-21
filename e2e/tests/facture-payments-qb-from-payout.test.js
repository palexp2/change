const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Section "Paiements et remboursements" du détail facture : pour une ligne
// Stripe (synthetic ou row réelle), si la JE QB est posée au niveau du payout
// (pas par ligne), la colonne QB doit lier vers le Deposit QB du payout au
// lieu d'afficher "au payout" / un bouton Retry inutile.
// Lecture-seule : on cherche une facture dont le payout lié a un qb_deposit_id.
describe('FacturePayments — lien QB Deposit via payout', () => {
  let browser, ctx, page, db, factureId, expectedQbDepositId

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })
    // Cherche une facture payée Stripe (synthetic row) dont le payout a été
    // poussé en QB (qb_deposit_id non null sur stripe_payouts).
    const row = db.prepare(`
      SELECT f.id AS facture_id, sp.qb_deposit_id
      FROM factures f
      JOIN stripe_balance_transactions bt ON bt.stripe_invoice_id = f.invoice_id
        AND bt.type IN ('charge','payment')
      JOIN stripe_payouts sp ON sp.stripe_id = bt.payout_stripe_id
      WHERE f.paid_at IS NOT NULL
        AND sp.qb_deposit_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.facture_id = f.id AND p.direction='in' AND p.method='stripe'
        )
      ORDER BY f.document_date DESC LIMIT 1
    `).get()
    if (!row) throw new Error('Aucune facture Stripe avec payout poussé en QB trouvée')
    factureId = row.facture_id
    expectedQbDepositId = row.qb_deposit_id

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
    db?.close()
    await browser?.close()
  })

  test('la colonne QB affiche un lien DEP #<id> vers le Deposit du payout', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })

    // Localise le <th>QB</th> de la section Paiements.
    const th = page.locator('th', { hasText: /^QB$/ }).first()
    await th.waitFor({ timeout: 8000 })
    const colIndex = await th.evaluate(el => {
      const ths = Array.from(el.parentElement.children)
      return ths.indexOf(el)
    })

    const tbody = th.locator('xpath=ancestor::table[1]').locator('tbody').first()
    const firstRowQbCell = tbody.locator('tr').first().locator('td').nth(colIndex)
    await firstRowQbCell.waitFor({ timeout: 5000 })

    // La cellule doit contenir un lien (<a>) vers le Deposit QB.
    const link = firstRowQbCell.locator('a').first()
    await link.waitFor({ timeout: 5000 })
    const text = (await link.textContent())?.trim() || ''
    assert.match(text, new RegExp(`DEP #${expectedQbDepositId}\\b`),
      `Le lien QB doit afficher "DEP #${expectedQbDepositId}" — reçu: "${text}"`)
    const href = await link.getAttribute('href')
    assert.ok(href && href.includes(`txnId=${expectedQbDepositId}`),
      `Le href du lien doit pointer vers le Deposit QB (txnId=${expectedQbDepositId}) — reçu: ${href}`)

    // Aucun bouton Retry ne doit être affiché à la place du lien.
    const retry = firstRowQbCell.locator('button', { hasText: /Retry/i })
    assert.equal(await retry.count(), 0, 'Aucun bouton Retry ne doit apparaître pour une ligne Stripe avec payout poussé')
  })
})
