const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie l'espacement visuel entre les colonnes Montant et Payout dans la
// section « Paiements et remboursements » du détail facture. Le `<th>` et le
// `<td>` Payout doivent avoir un padding-left > 0 (Tailwind `pl-4` = 16px).
// Lecture-seule sur la DB — sélectionne une facture existante avec paiements.
describe('FacturePayments — colonne Payout décollée de Montant', () => {
  let browser, ctx, page, db, factureId

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })
    const fac = db.prepare(`
      SELECT f.id FROM factures f
      WHERE EXISTS (SELECT 1 FROM payments p WHERE p.facture_id = f.id AND p.direction = 'in')
      ORDER BY f.document_date DESC LIMIT 1
    `).get()
    if (!fac) throw new Error('Aucune facture avec paiement « in » trouvée')
    factureId = fac.id

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

  test('le <th>Payout</th> a un padding-left > 0', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const th = page.locator('th', { hasText: /^Payout$/ }).first()
    await th.waitFor({ timeout: 5000 })
    const padLeft = await th.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
    assert.ok(padLeft > 0, `padding-left du <th>Payout</th> doit être > 0 (reçu: ${padLeft}px)`)
  })

  test('la première <td> Payout a un padding-left > 0', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const th = page.locator('th', { hasText: /^Payout$/ }).first()
    await th.waitFor({ timeout: 5000 })
    // Trouve l'index de la colonne Payout dans son thead.
    const colIndex = await th.evaluate(el => {
      const ths = Array.from(el.parentElement.children)
      return ths.indexOf(el)
    })
    const tbody = page.locator('table tbody').first()
    const firstRowTd = tbody.locator('tr').first().locator('td').nth(colIndex)
    await firstRowTd.waitFor({ timeout: 5000 })
    const padLeft = await firstRowTd.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
    assert.ok(padLeft > 0, `padding-left de la <td> Payout doit être > 0 (reçu: ${padLeft}px)`)
  })
})
