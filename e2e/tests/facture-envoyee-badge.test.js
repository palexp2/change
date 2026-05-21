const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que le toggle « Envoyée » (cochable Oui/Non) a été remplacé par un simple
// badge informatif. La case à cocher ne doit plus exister.
describe('FactureDetail — badge « Envoyée » remplace le toggle', () => {
  let browser, ctx, page, db
  let factureWithShipmentId
  let factureWithoutShipmentId

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })

    // Facture avec envoi lié → is_sent doit être true
    const facShipped = db.prepare(`
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
    if (!facShipped) throw new Error('Aucune facture avec envoi lié — impossible de tester le badge')
    factureWithShipmentId = facShipped.id

    // Facture sans envoi lié et sans is_sent_manual → is_sent doit être false
    const facUnshipped = db.prepare(`
      SELECT f.id
      FROM factures f
      WHERE (f.kind = 'order' OR f.kind IS NULL)
        AND (f.is_sent_manual = 0 OR f.is_sent_manual IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM shipments sh
          LEFT JOIN orders od ON od.id = f.order_id
          LEFT JOIN orders op ON op.project_id = f.project_id AND f.project_id IS NOT NULL
          WHERE sh.order_id = od.id OR sh.order_id = op.id
        )
      LIMIT 1
    `).get()
    if (!facUnshipped) throw new Error('Aucune facture sans envoi lié — impossible de tester l\'état "—"')
    factureWithoutShipmentId = facUnshipped.id

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

  test('facture avec envoi lié affiche un badge vert « Envoyée »', async () => {
    await page.goto(`${URL}/factures/${factureWithShipmentId}`, { waitUntil: 'networkidle' })
    // Le label « Envoyée » est présent, puis un badge (pas une case à cocher)
    const label = page.locator('text=Envoyée').first()
    await label.waitFor({ timeout: 5000 })
    // Le badge doit contenir le texte « Envoyée »
    const badge = page.locator('p:has-text("Envoyée") + span:has-text("Envoyée")')
    assert.equal(await badge.count() > 0, true, 'le badge « Envoyée » devrait être visible')
    // Plus de checkbox dans la section
    const checkbox = page.locator('input[type="checkbox"]').filter({ hasText: '' }).first()
    // Vérifie qu'aucune checkbox dans le label « Envoyée » n'existe (recherche plus précise)
    const labelToggle = page.locator('label[title*="forcer"]')
    assert.equal(await labelToggle.count(), 0, 'l\'ancien label avec toggle ne doit plus exister')
  })

  test('facture sans envoi lié affiche « — » au lieu du badge', async () => {
    await page.goto(`${URL}/factures/${factureWithoutShipmentId}`, { waitUntil: 'networkidle' })
    const label = page.locator('text=Envoyée').first()
    await label.waitFor({ timeout: 5000 })
    // Pas de badge « Envoyée » à côté du label
    const badgeCount = await page.locator('p:has-text("Envoyée") + span:has-text("Envoyée")').count()
    assert.equal(badgeCount, 0, 'le badge ne devrait pas être visible pour une facture non envoyée')
    // Le tiret « — » doit être présent dans la cellule du grid
    const dashCell = page.locator('p:has-text("Envoyée") + span').first()
    const text = await dashCell.textContent()
    assert.match(text || '', /—/)
  })
})
