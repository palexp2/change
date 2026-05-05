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

// Vérifie le clic-droit "Modifier le type / Supprimer" sur une colonne Airtable
// dans le DataTable, ainsi que les endpoints PATCH/DELETE /api/airtable-fields.
//
// On crée une colonne factice + une def pour ne pas toucher aux vraies données :
//   - column = `cf_test_<uuid>` dans `projects`
//   - def dans `airtable_field_defs` avec field_type='text'
// Tout est nettoyé en after().
describe('Airtable field — clic-droit modifier/supprimer', () => {
  let browser, ctx, page, token, db
  const colName = 'cf_test_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const fieldLabel = 'Test E2E ' + Date.now()
  let defId = null
  let frozenColName = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    // 1. Crée la colonne en DB
    db.exec(`ALTER TABLE projects ADD COLUMN ${colName} TEXT`)
    // 2. Insère une def Airtable factice
    defId = randomUUID()
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, 'projets', 'projects', ?, ?, ?, 'text', '{}', 999)
    `).run(defId, 'rec_test_' + defId.slice(0, 6), fieldLabel, colName)

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
    // Cleanup : supprime la def + la colonne si encore présentes
    try {
      if (defId) db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(defId)
    } catch {}
    try {
      const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name)
      if (cols.includes(colName)) db.exec(`ALTER TABLE projects DROP COLUMN ${colName}`)
    } catch {}
    if (frozenColName) {
      try { db.prepare('DELETE FROM airtable_frozen_columns WHERE erp_table=? AND column_name=?').run('projects', frozenColName) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('PATCH /api/airtable-fields/:id modifie le field_type', async () => {
    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_type: 'number' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: defId })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.field_type, 'number')

    // Vérifie en DB
    const row = db.prepare('SELECT field_type FROM airtable_field_defs WHERE id=?').get(defId)
    assert.equal(row.field_type, 'number')
  })

  test('PATCH refuse un field_type invalide', async () => {
    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_type: 'banane' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: defId })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /field_type/)
  })

  test('DELETE refuse une colonne frozen', async () => {
    // Marque la colonne comme frozen
    frozenColName = colName
    db.prepare(`
      INSERT OR IGNORE INTO airtable_frozen_columns (erp_table, column_name) VALUES (?, ?)
    `).run('projects', colName)

    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}` },
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: defId })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /frozen|gelée/i)

    // Cleanup frozen flag pour le test suivant
    db.prepare('DELETE FROM airtable_frozen_columns WHERE erp_table=? AND column_name=?').run('projects', colName)
    frozenColName = null

    // Def + colonne toujours là
    const def = db.prepare('SELECT id FROM airtable_field_defs WHERE id=?').get(defId)
    assert.ok(def)
    const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name)
    assert.ok(cols.includes(colName))
  })

  test('Clic-droit sur header Airtable montre le menu modifier/supprimer', async () => {
    // Ajoute la colonne aux visible_columns de TOUTES les pills + admin config,
    // pour qu'elle apparaisse quelle que soit la vue active.
    const pills = await page.evaluate(async ({ tok, col }) => {
      const cfg = await fetch('/erp/api/views/projects', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json())
      const adminVisible = (cfg.config?.visible_columns || []).slice()
      if (!adminVisible.includes(col)) adminVisible.push(col)
      await fetch('/erp/api/views/projects', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible_columns: adminVisible, default_sort: cfg.config?.default_sort || [] }),
      })
      // Patch chaque pill pour inclure la colonne
      const updated = []
      for (const p of (cfg.pills || [])) {
        const vc = (p.visible_columns || []).slice()
        const had = vc.includes(col)
        if (!had) vc.push(col)
        await fetch(`/erp/api/views/projects/pills/${p.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ visible_columns: vc }),
        })
        updated.push({ id: p.id, hadCol: had, originalVisible: p.visible_columns || [] })
      }
      return updated
    }, { tok: token, col: colName })

    try {
      await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
      const header = page.locator(`div[draggable="true"]`, { hasText: fieldLabel }).first()
      await header.waitFor({ state: 'visible', timeout: 15000 })
      await header.click({ button: 'right' })
      await page.locator('text=Modifier le type').waitFor({ state: 'visible', timeout: 5000 })
      await page.locator('text=Supprimer').waitFor({ state: 'visible', timeout: 2000 })
    } finally {
      // Restore les pills à leur état original
      await page.evaluate(async ({ tok, original }) => {
        for (const p of original) {
          await fetch(`/erp/api/views/projects/pills/${p.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ visible_columns: p.originalVisible }),
          })
        }
      }, { tok: token, original: pills })
    }
  })

  test('DELETE supprime la colonne ET la def', async () => {
    const r = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/airtable-fields/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tok}` },
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, id: defId })
    assert.equal(r.status, 200, JSON.stringify(r.body))

    // Def supprimée
    const def = db.prepare('SELECT id FROM airtable_field_defs WHERE id=?').get(defId)
    assert.equal(def, undefined)

    // Colonne supprimée
    const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name)
    assert.ok(!cols.includes(colName), `La colonne ${colName} aurait dû être DROP`)

    // Marque defId comme déjà nettoyé pour after()
    defId = null
  })
})
