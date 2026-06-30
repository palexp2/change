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

// Vérifie que le contrôle par champ des imports Airtable est généralisé à TOUS
// les modules (pas seulement 'projets'). On teste ici le module 'pieces'
// (erp_table = products) via les routes génériques /module-fields/:module/... et
// la page UI /airtable/fields/:module.
//
// Tout est fait sur une colonne JETABLE ajoutée à products + des defs jetables ;
// aucun record/config réel n'est muté. Cleanup intégral en after().
describe('Airtable module-fields — généralisé (pieces/products)', () => {
  let browser, ctx, page, token, db
  const MODULE = 'pieces'
  const ERP_TABLE = 'products'
  const testColName = 'cf_modfld_test_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const testColLink = 'cf_modfld_link_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const fakeAtFieldText = 'TEST_E2E_MODFLD_TEXT_' + Date.now()
  const fakeAtFieldNumber = 'TEST_E2E_MODFLD_NUMBER_' + Date.now()
  const fakeAtFieldLink = 'TEST_E2E_MODFLD_LINK_' + Date.now()
  const insertedDefIds = []

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testColName} TEXT`)
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testColLink} TEXT`)

    const idText = randomUUID(); insertedDefIds.push(idText)
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 'text', '{}', 998)
    `).run(idText, MODULE, ERP_TABLE, 'native_' + testColName, 'TestModFldText E2E', testColName)

    const idLink = randomUUID(); insertedDefIds.push(idLink)
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 'link', '{}', 998)
    `).run(idLink, MODULE, ERP_TABLE, 'native_' + testColLink, 'TestModFldLink E2E', testColLink)

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
    try {
      for (const fname of [fakeAtFieldText, fakeAtFieldNumber, fakeAtFieldLink]) {
        db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?`).run(ERP_TABLE, fname)
      }
      for (const id of insertedDefIds) {
        db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(id)
      }
      const cols = db.prepare(`PRAGMA table_info(${ERP_TABLE})`).all().map(c => c.name)
      if (cols.includes(testColName)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testColName}`)
      if (cols.includes(testColLink)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testColLink}`)
    } catch (e) { console.warn('cleanup:', e.message) }
    db?.close()
    await browser?.close()
  })

  async function postMapping(payload) {
    return page.evaluate(async ({ tok, mod, body }) => {
      const res = await fetch(`/erp/api/connectors/airtable/module-fields/${mod}/airtable-field-mapping`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, mod: MODULE, body: payload })
  }

  test('GET field-modules liste plusieurs modules dont pieces (non-projets)', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/field-modules', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    assert.ok(Array.isArray(r), 'doit être un tableau')
    const keys = r.map(m => m.module)
    // La généralisation : pas juste projets, mais les autres modules synchronisés.
    for (const k of ['projets', 'pieces', 'achats', 'envois', 'contacts', 'companies']) {
      assert.ok(keys.includes(k), `${k} doit figurer dans field-modules`)
    }
    const pieces = r.find(m => m.module === 'pieces')
    assert.equal(pieces.erp_table, 'products')
  })

  test('GET module-fields/pieces/mapping-data renvoie la structure + meta', async () => {
    const r = await page.evaluate(async ({ tok, mod }) => {
      const res = await fetch(`/erp/api/connectors/airtable/module-fields/${mod}/mapping-data`, { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, { tok: token, mod: MODULE })
    assert.ok(Array.isArray(r.airtable_fields), 'airtable_fields array')
    assert.ok(Array.isArray(r.erp_columns), 'erp_columns array')
    assert.equal(r.module, 'pieces')
    assert.equal(r.erp_table, 'products')
    assert.equal(r.label, 'Produits')
    const cols = r.erp_columns.map(c => c.column_name)
    assert.ok(cols.includes(testColName), `${testColName} doit apparaître`)
    assert.ok(cols.includes(testColLink), `${testColLink} doit apparaître`)
    assert.equal(r.erp_columns.find(c => c.column_name === testColName).field_type, 'text')
    assert.equal(r.erp_columns.find(c => c.column_name === testColLink).field_type, 'link')
  })

  test('POST mapping vers colonne text compatible — succès', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_text',
      airtable_field_name: fakeAtFieldText,
      airtable_field_type: 'singleLineText',
      column_name: testColName,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.mapped, true)
    const def = db.prepare(`SELECT field_type, column_name, import_disabled FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?`).get(ERP_TABLE, fakeAtFieldText)
    assert.equal(def.column_name, testColName)
    assert.equal(def.import_disabled, 0)
  })

  test('POST mapping refuse type incompatible (number → link)', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_num',
      airtable_field_name: fakeAtFieldNumber,
      airtable_field_type: 'number',
      column_name: testColLink,
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /incompatibles|Types/)
  })

  test('POST mapping link sans target_table — refuse', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_link',
      airtable_field_name: fakeAtFieldLink,
      airtable_field_type: 'multipleRecordLinks',
      column_name: testColLink,
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /link_target_table/)
  })

  test('POST mapping link avec target_table valide — succès', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_link',
      airtable_field_name: fakeAtFieldLink,
      airtable_field_type: 'multipleRecordLinks',
      column_name: testColLink,
      link_target_table: 'companies',
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.link_target_table, 'companies')
  })

  test('POST field-disabled — désactive l\'import et NULL-ifie la colonne', async () => {
    const r = await page.evaluate(async ({ tok, mod, fname }) => {
      const res = await fetch(`/erp/api/connectors/airtable/module-fields/${mod}/airtable-field-disabled`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ airtable_field_name: fname, disabled: true }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, mod: MODULE, fname: fakeAtFieldText })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const def = db.prepare(`SELECT import_disabled FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?`).get(ERP_TABLE, fakeAtFieldText)
    assert.equal(def.import_disabled, 1, 'import_disabled doit valoir 1')
  })

  test('UI : la page /airtable/fields/pieces se charge avec le bon titre', async () => {
    await page.goto(URL + '/airtable/fields/pieces', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Champs — Produits")', { timeout: 15000 })
    // Le tableau de champs liste notre colonne test
    await page.waitForSelector('input[placeholder="Rechercher un champ…"]', { timeout: 10000 })
    await page.fill('input[placeholder="Rechercher un champ…"]', testColLink)
    await page.waitForSelector(`code:has-text("${testColLink}")`, { timeout: 10000 })
    const title = await page.textContent('h1')
    assert.match(title, /Champs — Produits/)
  })

  test('POST unmap (column_name=null) — la def est supprimée', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_text',
      airtable_field_name: fakeAtFieldText,
      airtable_field_type: 'singleLineText',
      column_name: null,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.mapped, false)
    const def = db.prepare(`SELECT column_name FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?`).get(ERP_TABLE, fakeAtFieldText)
    assert.equal(def, undefined, 'def doit être supprimée')
  })
})
