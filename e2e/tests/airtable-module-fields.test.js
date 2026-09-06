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
// l'onglet Airtable de la page de configuration des champs (ex-/airtable/fields/:module).
//
// Modèle de données courant (l'ancien `airtable_field_defs` a été scindé) :
//   • airtable_field_mappings — quel champ Airtable alimente quelle colonne ERP
//     (+ import_disabled) ;
//   • custom_fields           — présentation de la colonne (nom affiché, type),
//     posée par POST /custom-fields/:table/adopt ou par le premier mapping.
//
// Tout est fait sur des colonnes JETABLES ajoutées à products + des mappings
// jetables ; aucun record ni configuration réelle n'est muté. Cleanup en after().
describe('Airtable module-fields — généralisé (pieces/products)', () => {
  let browser, ctx, page, token, db
  const MODULE = 'pieces'
  const ERP_TABLE = 'products'
  // Pas de préfixe cf_ : mapping-data masque les colonnes cf_* orphelines
  // (résidus de champs supprimés), et la colonne « lien » doit justement rester
  // orpheline jusqu'à son premier mapping.
  const testColName = 'e2e_mf_text_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const testColLink = 'e2e_mf_link_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const testColNum = 'e2e_mf_num_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const adoptedLabel = 'TestModFldText E2E'
  const fakeAtFieldText = 'TEST_E2E_MODFLD_TEXT_' + Date.now()
  const fakeAtFieldNumber = 'TEST_E2E_MODFLD_NUMBER_' + Date.now()
  const fakeAtFieldLink = 'TEST_E2E_MODFLD_LINK_' + Date.now()

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testColName} TEXT`)
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testColLink} TEXT`)
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testColNum} TEXT`)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Adoption de la colonne texte : pose sa présentation (nom + type) comme le
    // fait l'UI. La colonne « lien » reste volontairement orpheline.
    const adopt = await page.evaluate(async ({ tok, tbl, col, name }) => {
      const res = await fetch(`/erp/api/custom-fields/${tbl}/adopt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_name: col, name, type: 'text' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, tbl: ERP_TABLE, col: testColName, name: adoptedLabel })
    assert.equal(adopt.status, 201, JSON.stringify(adopt.body))

    // Colonne présentée en NOMBRE : sert au test d'incompatibilité de type.
    const adoptNum = await page.evaluate(async ({ tok, tbl, col }) => {
      const res = await fetch(`/erp/api/custom-fields/${tbl}/adopt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_name: col, name: 'TestModFldNum E2E', type: 'number' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, tbl: ERP_TABLE, col: testColNum })
    assert.equal(adoptNum.status, 201, JSON.stringify(adoptNum.body))
  })

  after(async () => {
    try {
      for (const fname of [fakeAtFieldText, fakeAtFieldNumber, fakeAtFieldLink]) {
        db.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND airtable_field_name=?').run(ERP_TABLE, fname)
      }
      for (const col of [testColName, testColLink, testColNum]) {
        db.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?').run(ERP_TABLE, col)
        db.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?').run(ERP_TABLE, col)
      }
      const cols = db.prepare(`PRAGMA table_info(${ERP_TABLE})`).all().map(c => c.name)
      if (cols.includes(testColName)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testColName}`)
      if (cols.includes(testColLink)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testColLink}`)
      if (cols.includes(testColNum)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testColNum}`)
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

  function mapping(fieldName) {
    return db.prepare(
      'SELECT column_name, import_disabled FROM airtable_field_mappings WHERE erp_table=? AND airtable_field_name=?'
    ).get(ERP_TABLE, fieldName)
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
    const adopted = r.erp_columns.find(c => c.column_name === testColName)
    // Colonne adoptée : nom et type viennent de custom_fields.
    assert.equal(adopted.field_type, 'text')
    assert.equal(adopted.label, adoptedLabel)
    assert.ok(adopted.cf_id, 'la colonne adoptée porte un cf_id')
    assert.ok(!adopted.mapped, 'pas encore mappée depuis Airtable')
    assert.equal(adopted.mapped_airtable_field, null)
    // Colonne orpheline : pas de présentation posée → type texte par défaut.
    const orphan = r.erp_columns.find(c => c.column_name === testColLink)
    assert.equal(orphan.field_type, 'text')
    assert.equal(orphan.cf_id, null)
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
    const m = mapping(fakeAtFieldText)
    assert.equal(m.column_name, testColName)
    assert.equal(m.import_disabled, 0)
    // Le mapping ne renomme pas une colonne déjà personnalisée.
    const cf = db.prepare('SELECT name, type FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL')
      .get(ERP_TABLE, testColName)
    assert.equal(cf.name, adoptedLabel)
    assert.equal(cf.type, 'text')
  })

  test('POST mapping refuse un type incompatible (texte → colonne nombre)', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_num',
      airtable_field_name: fakeAtFieldNumber,
      airtable_field_type: 'singleLineText',
      column_name: testColNum,
    })
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /incompatibles|Types/)
  })

  test('POST mapping refuse une colonne déjà mappée par un autre champ', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_num',
      airtable_field_name: fakeAtFieldNumber,
      airtable_field_type: 'number',
      column_name: testColName, // déjà pris par fakeAtFieldText
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
    assert.equal(r.body.link_target_table, 'companies')
    // Premier mapping d'une colonne orpheline : la présentation est posée
    // automatiquement (rendu texte + indice « lien Airtable »).
    const cf = db.prepare('SELECT name, type, source, options FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL')
      .get(ERP_TABLE, testColLink)
    assert.equal(cf.name, fakeAtFieldLink)
    assert.equal(cf.type, 'text')
    assert.equal(cf.source, 'airtable')
    assert.match(cf.options || '', /airtable_link_hint/)
  })

  test('POST field-disabled — désactive l\'import du champ', async () => {
    const r = await page.evaluate(async ({ tok, mod, fname }) => {
      const res = await fetch(`/erp/api/connectors/airtable/module-fields/${mod}/airtable-field-disabled`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ airtable_field_name: fname, disabled: true }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, mod: MODULE, fname: fakeAtFieldText })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(mapping(fakeAtFieldText).import_disabled, 1, 'import_disabled doit valoir 1')
  })

  test('UI : /airtable/fields/pieces redirige vers la config des champs produits', async () => {
    await page.goto(URL + '/airtable/fields/pieces', { waitUntil: 'domcontentloaded' })
    // Ancienne URL → onglet Airtable de /champs/products (interface fusionnée).
    await page.waitForURL(/\/champs\/products\?tab=pieces/, { timeout: 15000 })
    await page.waitForSelector('h1:has-text("Configuration des champs — Produits")', { timeout: 15000 })
    // Le tableau fusionné (champs + mapping Airtable) liste notre colonne test.
    await page.waitForSelector('[data-testid^="fieldcfg-airtable-"]', { timeout: 30000 })
    await page.fill('[data-testid="fieldcfg-search"]', testColLink)
    await page.waitForSelector(`[data-testid="fieldcfg-row-${testColLink}"]`, { timeout: 10000 })
    const title = await page.textContent('h1')
    assert.match(title, /Configuration des champs — Produits/)
  })

  test('POST unmap (column_name=null) — le mapping est supprimé', async () => {
    const r = await postMapping({
      airtable_field_id: 'rec_fake_text',
      airtable_field_name: fakeAtFieldText,
      airtable_field_type: 'singleLineText',
      column_name: null,
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.mapped, false)
    assert.equal(mapping(fakeAtFieldText), undefined, 'mapping doit être supprimé')
    // La colonne et sa présentation survivent au démappage.
    const cf = db.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL')
      .get(ERP_TABLE, testColName)
    assert.ok(cf, 'le champ de rendu reste en place')
  })
})
