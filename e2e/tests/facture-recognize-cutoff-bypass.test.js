const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const CUTOFF = '2026-05-01'

// Vérifie le garde-fou du bouton « Constater manuellement » face au cutoff comptable.
// Lecture seule en DB (sélection des factures) — on ne modifie rien et on ne clique
// JAMAIS « Forcer la constatation » : ça posterait une JE réelle dans QuickBooks prod.
describe('FactureAccountingSection — bypass cutoff du 1er mai', () => {
  let browser, ctx, page, db
  let preCutoffId, postCutoffId

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })

    // Facture pré-cutoff non encore constatée → la modale doit exiger le bypass.
    const pre = db.prepare(`
      SELECT id FROM factures
      WHERE document_date < ? AND (kind = 'order' OR kind IS NULL)
        AND revenue_recognized_at IS NULL
        AND (status IS NULL OR status != 'Void')
        AND amount_before_tax_cad IS NOT NULL
      ORDER BY document_date DESC LIMIT 1
    `).get(CUTOFF)
    // Facture post-cutoff non constatée → modale normale, pas d'avertissement.
    const post = db.prepare(`
      SELECT id FROM factures
      WHERE document_date >= ? AND (kind = 'order' OR kind IS NULL)
        AND revenue_recognized_at IS NULL
        AND (status IS NULL OR status != 'Void')
        AND amount_before_tax_cad IS NOT NULL
      ORDER BY document_date ASC LIMIT 1
    `).get(CUTOFF)
    if (!pre) throw new Error('Aucune facture pré-cutoff éligible — impossible de tester')
    if (!post) throw new Error('Aucune facture post-cutoff éligible — impossible de tester')
    preCutoffId = pre.id
    postCutoffId = post.id

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

  test('facture pré-cutoff : confirmation bloquée tant que le bypass n\'est pas coché', async () => {
    await page.goto(`${URL}/factures/${preCutoffId}`, { waitUntil: 'networkidle' })
    const section = page.locator('[data-testid="facture-accounting-section"]')
    await section.waitFor({ timeout: 5000 })
    await section.locator('[data-testid="accounting-recognize-btn"]').click()

    const confirmBtn = page.locator('[data-testid="accounting-recognize-confirm"]')
    await confirmBtn.waitFor({ timeout: 5000 })

    // L'avertissement cutoff est présent et la confirmation est désactivée.
    await page.locator('[data-testid="recognize-cutoff-warning"]').waitFor({ timeout: 5000 })
    assert.equal(await confirmBtn.isDisabled(), true, 'confirm devrait être désactivé avant bypass')
    assert.match(await confirmBtn.innerText(), /Forcer la constatation/)

    // Cocher le bypass active la confirmation.
    await page.locator('[data-testid="recognize-bypass-cutoff"]').check()
    assert.equal(await confirmBtn.isDisabled(), false, 'confirm devrait être actif après bypass')

    // On ne confirme JAMAIS — fermer sans poster à QB.
    await page.locator('button:has-text("Annuler")').click()
    await confirmBtn.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('facture post-cutoff : pas d\'avertissement, confirmation active d\'emblée', async () => {
    await page.goto(`${URL}/factures/${postCutoffId}`, { waitUntil: 'networkidle' })
    const section = page.locator('[data-testid="facture-accounting-section"]')
    await section.waitFor({ timeout: 5000 })
    await section.locator('[data-testid="accounting-recognize-btn"]').click()

    const confirmBtn = page.locator('[data-testid="accounting-recognize-confirm"]')
    await confirmBtn.waitFor({ timeout: 5000 })

    assert.equal(await page.locator('[data-testid="recognize-cutoff-warning"]').count(), 0)
    assert.equal(await confirmBtn.isDisabled(), false)
    assert.match(await confirmBtn.innerText(), /Constater sur QuickBooks/)

    await page.locator('button:has-text("Annuler")').click()
    await confirmBtn.waitFor({ state: 'detached', timeout: 5000 })
  })
})
