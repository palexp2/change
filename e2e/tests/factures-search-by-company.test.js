const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

describe('Factures — recherche par nom d\'entreprise', () => {
  let browser, ctx, page, db
  let companyName

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })

    // Sélectionne une entreprise dont le nom apparaît dans plusieurs factures (>=2),
    // est >= 4 chars, et n'apparaît dans AUCUN document_number ni order_number ni
    // project_name (pour s'assurer que les hits ne viennent que du company_name).
    const candidates = db.prepare(`
      SELECT co.name, COUNT(*) AS nb
      FROM factures f
      JOIN companies co ON f.company_id = co.id
      WHERE co.name IS NOT NULL AND length(co.name) >= 4
      GROUP BY co.id
      HAVING nb >= 2
      ORDER BY nb DESC
      LIMIT 30
    `).all()
    for (const c of candidates) {
      const name = c.name
      const collide = db.prepare(`
        SELECT 1 FROM factures f
        LEFT JOIN projects p ON f.project_id = p.id
        LEFT JOIN orders o ON f.order_id = o.id
        WHERE (f.document_number LIKE '%' || ? || '%' COLLATE NOCASE)
           OR (o.order_number LIKE '%' || ? || '%' COLLATE NOCASE)
           OR (p.name LIKE '%' || ? || '%' COLLATE NOCASE)
        LIMIT 1
      `).get(name, name, name)
      if (!collide) { companyName = name; break }
    }
    if (!companyName) throw new Error('Aucune entreprise testable trouvée')

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

  test('saisir le nom d\'entreprise dans la recherche filtre la liste', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })

    // Attendre qu'au moins un lien d'entreprise (rendu par RENDERS.company_name) soit visible
    await page.waitForSelector('a[href*="/companies/"]', { timeout: 15000 })

    const initialCount = await page.locator('a[href*="/companies/"]').count()
    assert.ok(initialCount > 0, 'aucune ligne avec lien entreprise au chargement')

    // Saisit le nom d'entreprise
    const searchInput = page.locator('input[placeholder="Rechercher..."]').first()
    await searchInput.fill(companyName)
    await page.waitForTimeout(500)

    const links = page.locator('a[href*="/companies/"]')
    const filteredCount = await links.count()
    assert.ok(
      filteredCount > 0,
      `recherche "${companyName}" ne renvoie aucune ligne (avant fix : 0 attendus car company_name n'était pas dans searchFields)`,
    )

    // Tous les liens entreprise visibles doivent avoir le nom recherché
    const re = new RegExp(escRe(companyName), 'i')
    const texts = await links.allInnerTexts()
    for (const t of texts) {
      assert.match(t, re, `lien entreprise "${t}" ne matche pas la recherche "${companyName}"`)
    }
  })
})
