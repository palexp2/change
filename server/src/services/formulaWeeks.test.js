import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const directory = mkdtempSync(join(tmpdir(), 'erp-formula-weeks-'))
process.env.DATABASE_PATH = join(directory, 'test.db')
const db = (await import('../db/database.js')).default
const { previewFormula, regenerateView, validateFormulaReferences } = await import('./customFieldsView.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

db.exec(`
  CREATE TABLE ops_issues (id TEXT PRIMARY KEY, created_at TEXT);
  CREATE TABLE shipments (id TEXT PRIMARY KEY, created_at TEXT);
  CREATE TABLE custom_fields (
    id TEXT PRIMARY KEY, erp_table TEXT, name TEXT, column_name TEXT, kind TEXT,
    formula_expr TEXT, lookup_fk TEXT, lookup_target_table TEXT, lookup_target_column TEXT,
    lookup_limit_n INTEGER, lookup_limit_dir TEXT, result_type TEXT,
    rollup_target_table TEXT, rollup_target_fk TEXT, rollup_target_column TEXT, rollup_agg TEXT,
    link_target_table TEXT, link_group_id TEXT, link_role TEXT, link_single INTEGER,
    sort_order INTEGER, created_at TEXT, deleted_at TEXT, view_error TEXT
  );
  INSERT INTO ops_issues VALUES ('issue', '2026-09-29T12:34:56Z');
  INSERT INTO shipments VALUES ('shipment', '2026-09-29T12:34:56Z');
`)

function preview(date, format) {
  db.prepare('UPDATE ops_issues SET created_at = ?').run(date)
  return previewFormula('ops_issues', `DATETIME_FORMAT(created_at, '${format}')`)[0].value
}

test('YYYY-ww affiche la semaine ISO, avec ou sans zéro initial', () => {
  assert.equal(preview('2026-09-29', 'YYYY-ww'), '2026-40')
  assert.equal(preview('2026-02-02', 'w ww W WW'), '6 06 6 06')
})

test('semaines ISO : lundi, dimanche, semaine 53 et changement d’année', () => {
  for (const [date, expected] of [
    ['2026-01-04', '2026-01'], ['2026-01-05', '2026-02'],
    ['2020-12-31', '2020-53'], ['2021-01-01', '2021-53'],
    ['2021-01-04', '2021-01'], ['2018-12-31', '2018-01'],
    ['2024-02-29', '2024-09'],
  ]) assert.equal(preview(date, 'YYYY-ww'), expected, date)
})

test('dates vides/invalides et calcul à l’heure du Québec', () => {
  for (const date of [null, '', 'pas une date']) assert.equal(preview(date, 'YYYY-ww'), null)
  // 01:30 UTC le lundi 5 = dimanche 4 à 20:30 (EST) : encore semaine 1.
  assert.equal(preview('2026-01-04T23:30:00-02:00', 'YYYY-ww'), '2026-01')
})

test('semaine qui commence le mardi à midi, été comme hiver (−36 h)', () => {
  const wk = (iso) => previewFormula('ops_issues', `DATETIME_FORMAT(DATEADD('${iso}', -36, 'hours'), 'YYYY-ww')`)[0].value
  assert.equal(wk('2026-10-06T15:59:00Z'), '2026-40') // 11:59 EDT
  assert.equal(wk('2026-10-06T16:00:00Z'), '2026-41') // 12:00 EDT
  assert.equal(wk('2026-12-01T16:59:00Z'), '2026-48') // 11:59 EST
  assert.equal(wk('2026-12-01T17:00:00Z'), '2026-49') // 12:00 EST
})

test('formats existants, littéraux et format par défaut conservés', () => {
  const date = '2026-09-29T12:34:56Z'
  assert.equal(preview(date, 'YYYY-MM-DD HH:mm:ss'), '2026-09-29 08:34:56')
  assert.equal(preview(date, 'YYYY-[ww]-ww'), '2026-ww-40')
  assert.equal(preview(date, ''), '2026-09-29T12:34:56.000Z')
  assert.equal(previewFormula('ops_issues', `CONCATENATE("DATETIME_FORMAT(", datetime_format(created_at, "YYYY-ww"))`)[0].value,
    'DATETIME_FORMAT(2026-40')
})

test('autres tables : comportement précédent préservé', () => {
  assert.equal(previewFormula('shipments', 'DATETIME_FORMAT(created_at, "YYYY-ww")')[0].value, '2026-ww')
})

test('formules sauvegardées et dépendances : résultat identique à l’aperçu', () => {
  db.prepare('UPDATE ops_issues SET created_at = ?').run('2026-02-02')
  const insert = db.prepare(`INSERT INTO custom_fields
    (id, erp_table, name, column_name, kind, formula_expr) VALUES (?, ?, ?, ?, 'formula', ?)`)
  for (const table of ['ops_issues', 'shipments']) {
    insert.run(`${table}-date`, table, 'Date', 'cf_date', 'created_at')
    insert.run(`${table}-week`, table, 'Semaine', 'cf_week', 'DATETIME_FORMAT(cf_date, "YYYY-ww")')
    assert.deepEqual(regenerateView(table).errors, [])
  }
  assert.doesNotThrow(() => validateFormulaReferences('DATETIME_FORMAT(cf_date, "YYYY-ww")', 'ops_issues'))
  assert.equal(db.prepare('SELECT cf_week FROM ops_issues_v').get().cf_week, '2026-06')
  assert.equal(previewFormula('ops_issues', 'DATETIME_FORMAT(cf_date, "YYYY-ww")')[0].value, '2026-06')
  assert.equal(db.prepare('SELECT cf_week FROM shipments_v').get().cf_week, '2026-ww')
})
