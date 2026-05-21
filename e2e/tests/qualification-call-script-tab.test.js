const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que chaque étape a exactement 2 onglets (Script + Battle Cards), et que
// l'onglet Script affiche le contenu fusionné de toutes les anciennes sous-sections
// avec leurs sous-titres.

describe('Onglets fusionnés en Script + Battle Cards', () => {
  let browser, ctx, page, db
  let createdCompanyId = null
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
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
    if (createdCallId) {
      try { db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(createdCallId) } catch {}
    }
    if (createdCompanyId) {
      try { db.prepare('DELETE FROM companies WHERE id = ?').run(createdCompanyId) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('chaque étape a Script + Battle Cards, Script affiche les anciennes sous-sections', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const beforeIds = new Set(db.prepare('SELECT id FROM companies').all().map(r => r.id))
    await page.locator('button:has-text("Nouvel appel")').first().click()
    await page.locator('button:has-text("Nouvelle entreprise")').first().click()

    const frameLoc = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frameLoc.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    const newCompany = db.prepare('SELECT id FROM companies').all().find(c => !beforeIds.has(c.id))
    if (newCompany) createdCompanyId = newCompany.id
    const callRow = db.prepare('SELECT id FROM qualification_calls WHERE company_id = ? ORDER BY created_at DESC LIMIT 1').get(createdCompanyId)
    if (callRow) createdCallId = callRow.id

    // Pour chaque étape testée, on vérifie : exactly 2 tabs (Script + Battle Cards),
    // et le Script tab contient les sous-titres attendus.
    const slidesToTest = [
      { idx: 0, label: 'Qualification', expectedSubheads: ['Open', 'Dig', 'Confirm'] },
      { idx: 3, label: 'How-we-help',  expectedSubheads: ['1. Remote access', '2. Climate', '3. Irrigation', '4. Disease & humidity', '5. Wind', '6. Other crops'] },
      { idx: 4, label: 'Ongoing service', expectedSubheads: ['Open with', '1. Configuration & installation', '2. Ongoing support', '3. Crop questions: Antoine', '4. 40 hour farmer program'] },
      { idx: 5, label: 'Demo',         expectedSubheads: ['Intro (before playing)', 'After the video', 'Ask for proposal consent'] },
    ]

    for (const slide of slidesToTest) {
      await frameLoc.locator('#assistant-panel').evaluate((_, idx) => {
        // eslint-disable-next-line no-undef
        if (typeof goTo === 'function') goTo(idx)
      }, slide.idx)
      await page.waitForTimeout(300)

      // Compter les onglets dans le step-zero principal de cette slide (le premier visible)
      const stepZero = frameLoc.locator('.step-zero[data-tab-set]').first()
      const tabCount = await stepZero.locator('.step-tab').count()
      assert.equal(tabCount, 2, `Étape ${slide.label}: doit avoir exactement 2 onglets (Script + Battle Cards), a ${tabCount}`)

      // Labels
      const scriptTab = stepZero.locator('.step-tab[data-tab="script"]')
      const bcTab = stepZero.locator('.step-tab[data-tab="battlecards"]')
      assert.ok(await scriptTab.isVisible(), `Étape ${slide.label}: onglet Script doit être visible`)
      assert.ok(await bcTab.isVisible(), `Étape ${slide.label}: onglet Battle Cards doit être visible`)
      assert.equal((await scriptTab.textContent()).trim(), 'Script', `Étape ${slide.label}: label de l'onglet Script`)
      assert.equal((await bcTab.textContent()).trim(), 'Battle Cards', `Étape ${slide.label}: label de l'onglet Battle Cards`)

      // Par défaut Script doit être actif. Vérifier que tous les sous-titres attendus sont visibles.
      for (const subhead of slide.expectedSubheads) {
        const el = stepZero.locator('.step-subhead', { hasText: subhead }).first()
        const visible = await el.isVisible().catch(() => false)
        assert.ok(visible, `Étape ${slide.label}: sous-titre "${subhead}" doit être visible sous l'onglet Script`)
      }

      // Switch vers Battle Cards et vérifier qu'on voit bien le contenu BC (pas le Script).
      await bcTab.click()
      await page.waitForTimeout(150)
      const bcCategory = stepZero.locator('.step-subhead', { hasText: 'Technical & compatibility' }).first()
      assert.ok(await bcCategory.isVisible(), `Étape ${slide.label}: catégorie Battle Cards "Technical & compatibility" doit être visible quand BC actif`)
      // Et le contenu Script doit être masqué — le premier sous-titre Script ne doit plus être visible
      const firstScriptSubhead = stepZero.locator('.step-subhead', { hasText: slide.expectedSubheads[0] }).first()
      const stillVisible = await firstScriptSubhead.isVisible().catch(() => false)
      assert.equal(stillVisible, false, `Étape ${slide.label}: sous-titre Script "${slide.expectedSubheads[0]}" doit être masqué quand BC actif`)
    }
  })
})
