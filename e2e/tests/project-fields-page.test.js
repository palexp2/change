const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')
const { randomUUID } = require('node:crypto')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie la page de gestion des champs /projects/fields :
// - Bouton "Champs" sur Pipeline navigue vers la page
// - La page rend le tableau avec les colonnes ERP
// - PATCH display_label modifie le label visible
// - PATCH field_type modifie le type
// - PUT /by-column crée une def pour une colonne orpheline
describe('Page de gestion des champs — /projects/fields', () => {
  let browser, ctx, page, token, db
  const testCol = 'cf_pftest_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const orphanCol = 'cf_pforph_' + randomUUID().replace(/-/g, '').slice(0, 8)
  let testDefId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    // Crée 2 colonnes test : une avec def, une orpheline
    db.exec(`ALTER TABLE projects ADD COLUMN ${testCol} TEXT`)
    db.exec(`ALTER TABLE projects ADD COLUMN ${orphanCol} TEXT`)
    testDefId = randomUUID()
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, 'projets', 'projects', ?, ?, ?, 'text', '{}', 999)
    `).run(testDefId, 'native_' + testCol, 'PFTest Label', testCol)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    try { db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(testDefId) } catch {}
    try {
      db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table='projects' AND column_name=?`).run(orphanCol)
      db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table='projects' AND column_name=?`).run(testCol)
    } catch {}
    try {
      const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name)
      if (cols.includes(testCol)) db.exec(`ALTER TABLE projects DROP COLUMN ${testCol}`)
      if (cols.includes(orphanCol)) db.exec(`ALTER TABLE projects DROP COLUMN ${orphanCol}`)
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('Bouton "Champs" sur /pipeline navigue vers /projects/fields', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('a:has-text("Champs")').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('a:has-text("Champs")').first().click()
    await page.waitForURL(/\/projects\/fields/, { timeout: 5000 })
    await page.locator('h1:has-text("Champs — Projets")').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('La page liste la colonne test avec son label et type', async () => {
    // Cherche dans la table notre colonne test
    await page.locator(`code:has-text("${testCol}")`).first().waitFor({ state: 'visible', timeout: 10000 })
    // Le label "PFTest Label" doit être présent
    await page.locator('text=PFTest Label').first().waitFor({ state: 'visible', timeout: 5000 })
  })

  test('PATCH display_label via API met à jour le label', async () => {
    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_label: 'Nouveau Label E2E' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: testDefId })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const def = db.prepare('SELECT display_label FROM airtable_field_defs WHERE id=?').get(testDefId)
    assert.equal(def.display_label, 'Nouveau Label E2E')
  })

  test('PATCH field_type modifie le type', async () => {
    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_type: 'long_text' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: testDefId })
    assert.equal(r.status, 200)
    const def = db.prepare('SELECT field_type FROM airtable_field_defs WHERE id=?').get(testDefId)
    assert.equal(def.field_type, 'long_text')
  })

  test('PUT /by-column crée une def pour une colonne orpheline', async () => {
    // Avant : pas de def pour orphanCol
    let def = db.prepare(`SELECT id FROM airtable_field_defs WHERE erp_table='projects' AND column_name=?`).get(orphanCol)
    assert.equal(def, undefined, 'pré-condition : pas de def')

    const r = await page.evaluate(async ({ tok, col }) => {
      const res = await fetch(`/erp/api/airtable-fields/by-column/projects/${col}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_label: 'Orphelin Label', field_type: 'number' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, col: orphanCol })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.created, true)

    def = db.prepare(`SELECT display_label, field_type FROM airtable_field_defs WHERE erp_table='projects' AND column_name=?`).get(orphanCol)
    assert.equal(def.display_label, 'Orphelin Label')
    assert.equal(def.field_type, 'number')
  })

  test('PUT /by-column refuse colonne système', async () => {
    const r = await page.evaluate(async ({ tok }) => {
      const res = await fetch(`/erp/api/airtable-fields/by-column/projects/id`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_label: 'Hack' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /système|system/i)
  })

  test('PUT /by-column refuse colonne inexistante', async () => {
    const r = await page.evaluate(async ({ tok }) => {
      const res = await fetch(`/erp/api/airtable-fields/by-column/projects/colonne_qui_nexiste_pas`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_type: 'text' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /introuvable|inconnue/i)
  })
})
