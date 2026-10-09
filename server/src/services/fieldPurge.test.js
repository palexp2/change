// Purge réelle d'un champ — les deux comportements qui, s'ils cassent, ne se
// voient pas tout de suite :
//
//   1. purger un champ NATIF ne doit pas le faire revenir. Le bug d'origine :
//      « Vider la corbeille » détruisait la ligne custom_fields, or c'était
//      elle qui tenait le champ hors de l'interface — le champ réapparaissait
//      sur toutes les fiches. La pierre tombale `purged_fields` doit prendre
//      le relais.
//   2. purger un champ PERSO doit vraiment détruire sa colonne (et donc ses
//      valeurs), vue <table>_v recréée derrière — sinon la colonne et les
//      données traînent en base pour toujours.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db. Uploads jetables aussi : la
// purge sauvegarde les valeurs détruites dans uploads/backups.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-field-purge-${process.pid}.db`)
process.env.UPLOADS_PATH = mkdtempSync(join(tmpdir(), 'erp-test-uploads-'))

const db = (await import('../db/database.js')).default
const { initSchema } = await import('../db/schema.js')
initSchema()
const migration = await import('../db/migrations/011-purged-fields.js')
migration.up(db)

const { purgeFields, purgedNativeFields, clearFieldTombstone, cleanPurgedReferences } = await import('./fieldPurge.js')

const columns = (table) => new Set(db.pragma(`table_info(${table})`).map(c => c.name))
const cfExists = (id) => !!db.prepare('SELECT 1 FROM custom_fields WHERE id=?').get(id)

// Champ dans la corbeille = ligne custom_fields soft-supprimée.
function trashedField({ id, column, name, kind = 'data' }) {
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source, deleted_at)
    VALUES (?, 'projects', ?, ?, 'number', ?, 'native', '2026-09-01T00:00:00.000Z')
  `).run(id, name, column, kind)
  return id
}

test('champ natif : la purge pose une pierre tombale permanente (le champ ne revient pas)', () => {
  trashedField({ id: 'f-native', column: 'monthly_cad', name: 'Mensuel (CAD)' })

  const out = purgeFields(['f-native'])

  assert.equal(out.purged, 1)
  assert.equal(cfExists('f-native'), false, 'la ligne de corbeille est détruite')
  assert.deepEqual(out.dropped, [], 'une colonne native n’est jamais droppée')
  assert.ok(columns('projects').has('monthly_cad'), 'la colonne native survit (routes et syncs la lisent)')

  const tombstones = purgedNativeFields('projects')
  assert.deepEqual(
    tombstones.map(t => [t.column_name, t.label]),
    [['monthly_cad', 'Mensuel (CAD)']],
    'le champ reste connu comme détruit → il sort de l’interface pour de bon'
  )
})

test('un champ vivant sur la même colonne l’emporte sur la pierre tombale', () => {
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source)
    VALUES ('f-readopted', 'projects', 'Mensuel', 'monthly_cad', 'number', 'data', 'airtable')
  `).run()

  assert.deepEqual(purgedNativeFields('projects'), [], 'ré-adopter la colonne ressuscite le champ')

  db.prepare(`DELETE FROM custom_fields WHERE id='f-readopted'`).run()
  assert.equal(purgedNativeFields('projects').length, 1)

  clearFieldTombstone('projects', 'monthly_cad')
  assert.deepEqual(purgedNativeFields('projects'), [], '« remettre » le champ efface la pierre tombale')
})

test('champ perso : la purge détruit la colonne et ses valeurs, la vue est recréée', () => {
  db.exec(`ALTER TABLE projects ADD COLUMN cf_budget REAL`)
  db.prepare(`INSERT INTO projects (id, name, cf_budget) VALUES ('p1', 'Projet test', 1234)`).run()
  trashedField({ id: 'f-perso', column: 'cf_budget', name: 'Budget' })

  const out = purgeFields(['f-perso'])

  assert.equal(out.purged, 1)
  assert.deepEqual(out.dropped, ['projects.cf_budget'])
  assert.equal(columns('projects').has('cf_budget'), false, 'la colonne est droppée')
  assert.equal(out.backups.length, 1, 'les valeurs détruites sont sauvegardées sur disque')

  // La vue existe encore et reste requêtable : c'est elle que lisent les routes.
  const view = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='view' AND name='projects_v'`).get()
  assert.ok(view, 'projects_v est recréée après le DROP COLUMN')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM projects_v`).get().n, 1)

  // Une colonne cf_ ne peut ressusciter (aucune définition codée en dur), donc
  // elle n'a pas à figurer dans les champs natifs détruits.
  assert.deepEqual(purgedNativeFields('projects').map(t => t.column_name), [])
})

test('ids inconnus : rien à purger, rien ne casse', () => {
  const out = purgeFields(['inexistant'])
  assert.deepEqual(out, { purged: 0, blocked: [], dropped: [], tombstones: 0, backups: [] })
  assert.deepEqual(purgeFields([]).dropped, [])
})

test('purge avec filtres groupés, anciens filtres et regroupements multiples', () => {
  db.exec('ALTER TABLE projects ADD COLUMN cf_purge_filters REAL')
  trashedField({ id: 'f-filters', column: 'cf_purge_filters', name: 'À purger' })
  const removed = { field: 'cf_purge_filters', op: 'equals', value: 12 }
  const kept = { field: 'name', op: 'contains', value: 'Projet' }
  const fixtures = [
    [{ conjunction: 'AND', rules: [removed, { conjunction: 'OR', rules: [removed, kept] }] },
      { conjunction: 'AND', rules: [{ conjunction: 'OR', rules: [kept] }] }],
    [{ conjunction: 'OR', rules: [{ conjunction: 'AND', rules: [removed] }, kept] },
      { conjunction: 'OR', rules: [kept] }],
    [[removed, kept], [kept]],
    // Tout le filtre reposait sur le champ détruit : la pastille est supprimée.
    [{ conjunction: 'AND', rules: [removed] }, undefined],
    [null, null],
  ]
  for (const [i, [filters]] of fixtures.entries()) {
    db.prepare(`INSERT INTO table_view_pills
      (id, table_name, label, filters, group_by, column_widths, visible_columns, sort, color_rules)
      VALUES (?, 'projects', 'Test purge', ?, ?, 'null', 'null', 'null', 'null')`)
      .run(`purge-filter-${i}`, JSON.stringify(filters), JSON.stringify(['cf_purge_filters', 'name']))
  }
  const out = purgeFields(['f-filters'])
  assert.equal(out.purged, 1)
  assert.equal(cfExists('f-filters'), false)
  assert.equal(columns('projects').has('cf_purge_filters'), false)
  for (const [i, [, expected]] of fixtures.entries()) {
    const pill = db.prepare('SELECT filters, group_by FROM table_view_pills WHERE id=?').get(`purge-filter-${i}`)
    if (expected === undefined) { assert.equal(pill, undefined); continue }
    assert.deepEqual(JSON.parse(pill.filters), expected)
    assert.deepEqual(JSON.parse(pill.group_by), ['name'])
  }
})

test('champ natif détruit : retiré des vues de sa clé de page et des colonnes gelées', () => {
  db.prepare(`INSERT INTO table_view_pills (id, table_name, label, filters, visible_columns, column_widths)
    VALUES ('ref-pill', 'retours', 'Réf', '[]', ?, ?)`)
    .run(JSON.stringify(['n_de_retour', 'vieux_champ']), JSON.stringify({ vieux_champ: 80, n_de_retour: 120 }))
  db.prepare(`INSERT INTO airtable_frozen_columns (erp_table, column_name) VALUES ('returns', 'vieux_champ')`).run()
  const out = cleanPurgedReferences('returns', ['vieux_champ'])
  assert.equal(out.pills, 1)
  assert.equal(out.frozen, 1)
  const pill = db.prepare('SELECT visible_columns, column_widths FROM table_view_pills WHERE id=?').get('ref-pill')
  assert.deepEqual(JSON.parse(pill.visible_columns), ['n_de_retour'])
  assert.deepEqual(JSON.parse(pill.column_widths), { n_de_retour: 120 })
})
