const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que les battle cards consolidées sont identiques à chaque étape :
// On crée un call (Nouvelle entreprise → company vide pour ne pas polluer une vraie company),
// on ouvre la slide view, on navigue d'étape en étape, et à chaque étape on clique sur l'onglet
// "Battle Cards" et on vérifie que les 4 catégories sont présentes : Technical & compatibility,
// Pricing & budget, Hesitation & decision, Access & setup.
// On vérifie aussi qu'au moins une objection "phare" par catégorie est présente, pour s'assurer
// que le contenu n'est pas seulement les titres mais bien la liste complète.

describe('Battle cards consolidées présentes à chaque étape', () => {
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

  test('chaque étape affiche les 4 catégories de battle cards', async () => {
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

    // Étapes à tester : index dans le slides array. Chaque step affiche un step-zero
    // avec une phase battlecards. On teste 0 (Qualif), 3 (How-we-help), 4 (Support),
    // 5 (Demo), 6 (Proposal). Pas 1 (Discovery) parce qu'elle partage avec 0 le même
    // discoveryScriptHTML. Pas 2 (Intro) ni 7 (Conclusion) parce qu'elles n'ont pas
    // de tab-set avec battlecards.
    const slidesToTest = [
      { idx: 0, label: 'Qualification' },
      { idx: 3, label: 'How-we-help' },
      { idx: 4, label: 'Ongoing service' },
      { idx: 5, label: 'Demo' },
      { idx: 6, label: 'Proposal' },
    ]

    const expectedCategories = [
      'Technical & compatibility',
      'Pricing & budget',
      'Hesitation & decision',
      'Access & setup',
    ]

    // Une "objection phare" par catégorie pour vérifier que le contenu suit, pas
    // juste les titres.
    const expectedSignatureIntents = [
      'IF: They give a technical answer',           // Technical
      "IF: It's expensive",                          // Pricing
      'IF: They say they need to think about it',   // Hesitation
      'IF: They ask about multiple user accounts',  // Access
    ]

    for (const slide of slidesToTest) {
      // Naviguer vers la slide via goTo() exposé sur window
      await frameLoc.locator('#assistant-panel').evaluate((_, idx) => {
        // eslint-disable-next-line no-undef
        if (typeof goTo === 'function') goTo(idx)
      }, slide.idx)
      await page.waitForTimeout(300)

      // Cliquer sur l'onglet Battle Cards dans cette slide.
      // Les onglets sont libellés "Battle Cards" (Qualif/Discovery) ou "BATTLE CARDS" (autres).
      const battleTab = frameLoc.locator('.step-tab[data-tab="battlecards"]').first()
      await battleTab.waitFor({ state: 'visible', timeout: 5000 })
      await battleTab.click()
      await page.waitForTimeout(150)

      // Vérifier les 4 catégories — chaque .step-subhead correspondant doit être visible.
      for (const cat of expectedCategories) {
        const subhead = frameLoc.locator(`.step-zero[data-active-tab="battlecards"] .step-subhead`, { hasText: cat }).first()
        const visible = await subhead.isVisible().catch(() => false)
        assert.ok(visible, `Étape ${slide.label}: catégorie "${cat}" doit être visible sous Battle Cards`)
      }

      // Vérifier les 4 objections phares
      for (const intent of expectedSignatureIntents) {
        const block = frameLoc.locator(`.step-zero[data-active-tab="battlecards"] .step-intent`, { hasText: intent }).first()
        const visible = await block.isVisible().catch(() => false)
        assert.ok(visible, `Étape ${slide.label}: objection "${intent}" doit être visible sous Battle Cards`)
      }
    }
  })
})
