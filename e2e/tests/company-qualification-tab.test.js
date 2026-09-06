const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que l'onglet "Qualification call" apparaît sur la fiche entreprise
// quand des qualification_calls sont liés à la company, et que le contenu
// (défis, gestion actuelle, modèles d'affaires…) s'affiche.
describe('CompanyDetail — onglet Qualification call', () => {
  let browser, ctx, page, db
  let companyId, companyName, expectedChallengeFragment, expectedFarmFragment

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })

    // Choisit la company avec le plus de qualification calls (idéalement >1).
    const row = db.prepare(`
      SELECT q.company_id, c.name,
             (SELECT challenges FROM qualification_calls
               WHERE company_id = q.company_id
                 AND challenges IS NOT NULL AND challenges != ''
               ORDER BY call_date DESC LIMIT 1) AS challenges,
             (SELECT farm_description FROM qualification_calls
               WHERE company_id = q.company_id
                 AND farm_description IS NOT NULL AND farm_description != ''
               ORDER BY call_date DESC LIMIT 1) AS farm_description,
             COUNT(*) AS n
      FROM qualification_calls q
      JOIN companies c ON c.id = q.company_id
      GROUP BY q.company_id
      ORDER BY n DESC, c.name
      LIMIT 1
    `).get()
    if (!row) throw new Error('Aucun qualification_call lié à une company — impossible de tester')
    companyId = row.company_id
    companyName = row.name
    // Extrait un fragment court et stable pour vérifier l'affichage.
    expectedChallengeFragment = (row.challenges || '').split(/[\n.]/).map(s => s.trim()).find(s => s.length >= 8) || ''
    expectedFarmFragment = (row.farm_description || '').split(/[\n.]/).map(s => s.trim()).find(s => s.length >= 8) || ''

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

  test(`onglet visible et contenu rendu pour ${companyName ? `"${companyName}"` : 'une company'}`, async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const tab = page.locator('button:has-text("Qualification call")').first()
    await tab.waitFor({ state: 'visible', timeout: 5000 })
    await tab.click()

    // En-tête de section (présent dès qu'un call est ouvert)
    await page.waitForSelector('text=Entreprise', { timeout: 5000 })
    await page.waitForSelector('text=Défis & motivation', { timeout: 5000 })
    await page.waitForSelector('text=Budget & décision', { timeout: 5000 })

    // Si l'item n'est pas auto-ouvert (>1 calls), clique pour ouvrir le 1er
    const sectionVisible = await page.locator('text=Principaux défis').isVisible().catch(() => false)
    if (!sectionVisible) {
      await page.locator('button:has(svg)').filter({ hasText: '' }).first().click().catch(() => {})
    }

    // Vérifie qu'un fragment connu du contenu apparaît
    if (expectedChallengeFragment) {
      const challengeLocator = page.locator(`text=${expectedChallengeFragment}`).first()
      await challengeLocator.waitFor({ state: 'visible', timeout: 5000 })
    }
    if (expectedFarmFragment) {
      const farmLocator = page.locator(`text=${expectedFarmFragment}`).first()
      await farmLocator.waitFor({ state: 'visible', timeout: 5000 })
    }

    // Footer de référence Airtable
    await page.waitForSelector('text=Communication interne', { timeout: 5000 })

    assert.ok(true)
  })
})
