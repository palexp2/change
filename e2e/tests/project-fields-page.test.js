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

// Gestion des champs projets — désormais la page de configuration des champs
// (/champs/projects, ex-/projects/fields), dont le tableau unique réunit les
// champs et leur mapping Airtable :
//   • le bouton « Champs » de /pipeline y navigue ;
//   • le tableau liste les colonnes ERP avec leur nom d'affichage et leur type ;
//   • renommage / changement de type = PUT /api/custom-fields/:id (le nom et le
//     type d'une colonne vivent dans custom_fields depuis la fusion de
//     l'ancien `airtable_field_defs`) ;
//   • adoption d'une colonne orpheline = POST /api/custom-fields/projects/adopt
//     (remplace l'ancien PUT /airtable-fields/by-column).
//
// Colonnes JETABLES ajoutées à projects, supprimées en after() — aucun record
// ni champ réel touché.
describe('Page de gestion des champs — projets', () => {
  let browser, ctx, page, token, db
  const ERP_TABLE = 'projects'
  const testCol = 'e2e_pftest_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const orphanCol = 'e2e_pforph_' + randomUUID().replace(/-/g, '').slice(0, 8)
  const testLabel = 'PFTest Label'
  let testCfId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    // Deux colonnes test : une avec présentation (champ adopté), une orpheline.
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${testCol} TEXT`)
    db.exec(`ALTER TABLE ${ERP_TABLE} ADD COLUMN ${orphanCol} TEXT`)

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const adopt = await adoptColumn(testCol, testLabel, 'text')
    assert.equal(adopt.status, 201, JSON.stringify(adopt.body))
    testCfId = adopt.body.id
  })

  after(async () => {
    try {
      for (const col of [testCol, orphanCol]) {
        db.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?').run(ERP_TABLE, col)
        db.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?').run(ERP_TABLE, col)
      }
      const cols = db.prepare(`PRAGMA table_info(${ERP_TABLE})`).all().map(c => c.name)
      if (cols.includes(testCol)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${testCol}`)
      if (cols.includes(orphanCol)) db.exec(`ALTER TABLE ${ERP_TABLE} DROP COLUMN ${orphanCol}`)
    } catch (e) { console.warn('cleanup:', e.message) }
    db?.close()
    await browser?.close()
  })

  function adoptColumn(column_name, name, type) {
    return page.evaluate(async ({ tok, tbl, body }) => {
      const res = await fetch(`/erp/api/custom-fields/${tbl}/adopt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, tbl: ERP_TABLE, body: { column_name, name, type } })
  }

  function updateField(id, body) {
    return page.evaluate(async ({ tok, fid, payload }) => {
      const res = await fetch(`/erp/api/custom-fields/${fid}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, fid: id, payload: body })
  }

  function cfRow() {
    return db.prepare('SELECT name, type FROM custom_fields WHERE id=?').get(testCfId)
  }

  test('Bouton "Champs" sur /pipeline navigue vers la config des champs projets', async () => {
    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    await page.locator('a:has-text("Champs")').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('a:has-text("Champs")').first().click()
    await page.waitForURL(/\/champs\/projects/, { timeout: 5000 })
    await page.locator('h1:has-text("Configuration des champs — Projets")').waitFor({ state: 'visible', timeout: 5000 })
  })

  test('Le tableau liste la colonne test avec son label et son type', async () => {
    // Le tableau fusionné attend les métadonnées Airtable (quelques secondes).
    await page.waitForSelector('[data-testid^="fieldcfg-airtable-"]', { timeout: 30000 })
    await page.fill('[data-testid="fieldcfg-search"]', testCol)
    const row = page.locator(`[data-testid="fieldcfg-row-${testCol}"]`)
    await row.waitFor({ state: 'visible', timeout: 10000 })
    // Nom éditable + type (celui de custom_fields, adopté en 'text').
    assert.equal(await row.locator(`[data-testid="fieldcfg-name-${testCol}"]`).inputValue(), testLabel)
    assert.match(await row.innerText(), /Texte/)
    // Colonne adoptée → pas de sélecteur d'adoption, mais une cellule de mapping.
    assert.equal(await row.locator(`[data-testid="fieldcfg-type-${testCol}"]`).count(), 0)
    assert.equal(await row.locator(`[data-testid="fieldcfg-airtable-${testCol}"]`).count(), 1)
  })

  test('PUT /custom-fields/:id renomme le champ', async () => {
    const r = await updateField(testCfId, { name: 'Nouveau Label E2E' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(cfRow().name, 'Nouveau Label E2E')
  })

  test('PUT /custom-fields/:id change le type d\'une colonne adoptée', async () => {
    // Autorisé parce que le champ vient d'une adoption Airtable (source='airtable',
    // kind='data') — un champ créé nativement garde son type figé.
    const r = await updateField(testCfId, { type: 'long_text' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(cfRow().type, 'long_text')
  })

  test('POST /adopt crée la présentation d\'une colonne orpheline', async () => {
    const before = db.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL')
      .get(ERP_TABLE, orphanCol)
    assert.equal(before, undefined, 'pré-condition : pas de champ sur la colonne orpheline')

    const r = await adoptColumn(orphanCol, 'Orphelin Label', 'number')
    assert.equal(r.status, 201, JSON.stringify(r.body))

    const created = db.prepare('SELECT name, type, source FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL')
      .get(ERP_TABLE, orphanCol)
    assert.equal(created.name, 'Orphelin Label')
    assert.equal(created.type, 'number')
    assert.equal(created.source, 'airtable')
  })

  test('POST /adopt refuse une colonne déjà adoptée', async () => {
    const r = await adoptColumn(orphanCol, 'Doublon', 'text')
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /déjà un champ actif/i)
  })

  test('POST /adopt refuse une colonne système', async () => {
    const r = await adoptColumn('id', 'Hack', 'text')
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /système|system/i)
  })

  test('POST /adopt refuse une colonne inexistante', async () => {
    const r = await adoptColumn('colonne_qui_nexiste_pas', 'Fantôme', 'text')
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /introuvable|inconnue/i)
  })
})
