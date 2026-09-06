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

// Vérifie le mapping explicite Airtable → ERP pour les projets :
// - GET mapping-data renvoie airtable_fields + erp_columns + hardcoded + airtable_table_to_erp
// - POST airtable-field-mapping accepte un mapping vers une colonne compatible
// - Refuse si types incompatibles
// - Refuse si la colonne est déjà mappée par un autre champ
// - Pour un lien : refuse sans target_table, accepte avec une table valide
// - Unmap remet à __pending__ + import_disabled=1
describe('Airtable projets — mapping explicite', () => {
  let browser, ctx, page, token, db
  const testColName = 'cf_map_test_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const testColLink = 'cf_map_link_' + randomUUID().replace(/-/g, '').slice(0, 8)
  // Ces champs Airtable sont fictifs — on insère/upsert directement via l'endpoint
  // sans dépendre de la résolution réelle Airtable. Pour ça on inserte un def
  // avec airtable_field_id 'pending_*' qui simule un champ déjà connu.
  const fakeAtFieldText = 'TEST_E2E_MAP_TEXT_' + Date.now()
  const fakeAtFieldNumber = 'TEST_E2E_MAP_NUMBER_' + Date.now()
  const fakeAtFieldLink = 'TEST_E2E_MAP_LINK_' + Date.now()
  const insertedDefIds = []

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    // Crée 2 colonnes test (text et number) + 1 colonne link FK
    db.exec(`ALTER TABLE projects ADD COLUMN ${testColName} TEXT`)
    db.exec(`ALTER TABLE projects ADD COLUMN ${testColLink} TEXT`)

    // Enregistre une def "native" pour ces colonnes (donne un type connu côté serveur).
    const idText = randomUUID(); insertedDefIds.push(idText)
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, 'projets', 'projects', ?, ?, ?, 'text', '{}', 998)
    `).run(idText, 'native_' + testColName, 'TestColText E2E', testColName)

    const idLink = randomUUID(); insertedDefIds.push(idLink)
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
      VALUES (?, 'projets', 'projects', ?, ?, ?, 'link', '{}', 998)
    `).run(idLink, 'native_' + testColLink, 'TestColLink E2E', testColLink)

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
    // Cleanup defs créées par les tests + colonnes
    try {
      for (const fname of [fakeAtFieldText, fakeAtFieldNumber, fakeAtFieldLink]) {
        db.prepare(`DELETE FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?`).run(fname)
      }
      for (const id of insertedDefIds) {
        db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(id)
      }
      const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(c => c.name)
      if (cols.includes(testColName)) db.exec(`ALTER TABLE projects DROP COLUMN ${testColName}`)
      if (cols.includes(testColLink)) db.exec(`ALTER TABLE projects DROP COLUMN ${testColLink}`)
    } catch (e) { console.warn('cleanup:', e.message) }
    db?.close()
    await browser?.close()
  })

  // Helper : appel direct au POST mapping
  async function postMapping(payload) {
    return page.evaluate(async ({ tok, body }) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/airtable-field-mapping', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, body: payload })
  }

  test('GET mapping-data renvoie la structure attendue', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/mapping-data', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    assert.ok(Array.isArray(r.airtable_fields), 'airtable_fields array')
    assert.ok(Array.isArray(r.erp_columns), 'erp_columns array')
    assert.ok(Array.isArray(r.hardcoded), 'hardcoded array')
    assert.ok(typeof r.airtable_table_to_erp === 'object', 'airtable_table_to_erp object')
    // erp_columns doit contenir nos colonnes test
    const cols = r.erp_columns.map(c => c.column_name)
    assert.ok(cols.includes(testColName), `${testColName} doit apparaître dans erp_columns`)
    assert.ok(cols.includes(testColLink), `${testColLink} doit apparaître dans erp_columns`)
    // Et le type connu (puisqu'on a inséré une native def)
    const colText = r.erp_columns.find(c => c.column_name === testColName)
    assert.equal(colText.field_type, 'text')
    const colLink = r.erp_columns.find(c => c.column_name === testColLink)
    assert.equal(colLink.field_type, 'link')
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
    // Def créée
    const def = db.prepare(`SELECT field_type, column_name, import_disabled FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?`).get(fakeAtFieldText)
    assert.equal(def.field_type, 'text')
    assert.equal(def.column_name, testColName)
    assert.equal(def.import_disabled, 0)
  })

  test('POST mapping refuse type incompatible (number → link)', async () => {
    // testColLink est de type 'link' et encore non claim — un champ number doit être refusé.
    const r = await postMapping({
      airtable_field_id: 'rec_fake_num',
      airtable_field_name: fakeAtFieldNumber,
      airtable_field_type: 'number',
      column_name: testColLink,
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /incompatibles|Types/)
  })

  test('POST mapping refuse colonne déjà mappée par un autre champ', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_text2',
      airtable_field_name: fakeAtFieldText + '_DUPL',
      airtable_field_type: 'singleLineText',
      column_name: testColName,
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /déjà mappée/)
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
    assert.equal(r.body.mapped, true)
    assert.equal(r.body.link_target_table, 'companies')
    const def = db.prepare(`SELECT field_type, column_name, options FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?`).get(fakeAtFieldLink)
    assert.equal(def.field_type, 'link')
    const opts = JSON.parse(def.options)
    assert.equal(opts.link_target_table, 'companies')
  })

  test('POST mapping link refuse table cible inconnue', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_link2',
      airtable_field_name: fakeAtFieldLink + '_BAD',
      airtable_field_type: 'multipleRecordLinks',
      column_name: testColLink,
      link_target_table: 'table_qui_n_existe_pas',
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /Table cible/)
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
    const def = db.prepare(`SELECT column_name FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?`).get(fakeAtFieldText)
    assert.equal(def, undefined, 'def doit être supprimée')
  })
})
