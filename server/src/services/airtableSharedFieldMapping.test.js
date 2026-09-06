// Un champ Airtable peut alimenter PLUSIEURS colonnes Boréal.
//
// Deux règles encadrent ce partage, et ce sont elles qu'on verrouille ici :
//   • à l'IMPORT, une def qui double un champ déjà lu par le field_map « cœur »
//     du module reste dormante tant qu'elle n'a pas été revendiquée
//     (`share_core_field`) — sans quoi de vieilles defs jumelles se seraient
//     réveillées d'un coup, dont products.image_url ;
//   • au WRITE-BACK, une seule colonne peut remplir un champ Airtable donné :
//     deux colonnes en écriture sur la même case, c'est une valeur tirée au sort.

import { tmpdir } from 'os'
import { join } from 'path'
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-shared-field-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`
  CREATE TABLE IF NOT EXISTS airtable_field_mappings (
    id TEXT PRIMARY KEY,
    module TEXT NOT NULL,
    erp_table TEXT NOT NULL,
    airtable_field_id TEXT,
    airtable_field_name TEXT,
    column_name TEXT NOT NULL,
    options TEXT DEFAULT '{}',
    import_disabled INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(erp_table, column_name)
  );
  CREATE TABLE IF NOT EXISTS airtable_field_directions (
    module TEXT NOT NULL,
    field_key TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'both',
    PRIMARY KEY (module, field_key)
  );
`)

const { sharesCoreField, hardcodedErpColumns } = await import('./airtableAutoSync.js')
const { buildColumnMap } = await import('./airtableWriteback.js')

describe('sharesCoreField — revendication d\'un champ déjà lu par le sync de base', () => {
  test('def ordinaire : dormante', () => {
    assert.equal(sharesCoreField({ options: '{}' }), false)
    assert.equal(sharesCoreField({ options: null }), false)
    assert.equal(sharesCoreField({}), false)
    assert.equal(sharesCoreField(null), false)
  })

  test('def revendiquée : servie', () => {
    assert.equal(sharesCoreField({ options: '{"share_core_field":true}' }), true)
  })

  test('options illisibles : dormante, pas d\'exception', () => {
    assert.equal(sharesCoreField({ options: '{pas du json' }), false)
  })

  test('valeur molle refusée — seul `true` revendique', () => {
    assert.equal(sharesCoreField({ options: '{"share_core_field":1}' }), false)
    assert.equal(sharesCoreField({ options: '{"share_core_field":"oui"}' }), false)
  })
})

describe('hardcodedErpColumns — colonnes que le sync de base remplit déjà', () => {
  test('clé logique et sa forme FK', () => {
    const cols = hardcodedErpColumns({ company: 'Client final', status: 'Statut' })
    assert.ok(cols.has('company') && cols.has('company_id'))
    assert.ok(cols.has('status') && cols.has('status_id'))
  })

  test('clé déjà suffixée : pas de doublon _id_id', () => {
    const cols = hardcodedErpColumns({ project_id: 'Projet' })
    assert.ok(cols.has('project_id'))
    assert.ok(!cols.has('project_id_id'))
  })
})

describe('buildColumnMap — une seule colonne écrit un champ Airtable', () => {
  const insert = db.prepare(`
    INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name)
    VALUES (?, 'envois', 'shipments', ?, ?, ?)
  `)
  const push = db.prepare(
    "INSERT OR REPLACE INTO airtable_field_directions (module, field_key, direction) VALUES ('envois', ?, 'push')"
  )

  test('deux colonnes poussant le même champ : la première garde la main', () => {
    db.exec('DELETE FROM airtable_field_mappings; DELETE FROM airtable_field_directions')
    insert.run('m1', 'fldNotes', 'Notes', 'notes')
    insert.run('m2', 'fldNotes', 'Notes', 'notes_copie')
    push.run('dyn:notes')
    push.run('dyn:notes_copie')

    const out = buildColumnMap('envois', {})
    const writers = Object.entries(out).filter(([, atField]) => atField === 'Notes')
    assert.equal(writers.length, 1, 'un seul écrivain pour « Notes »')
    assert.equal(writers[0][0], 'notes')
  })

  test('la seconde colonne redevient écrivain si la première ne pousse pas', () => {
    db.exec('DELETE FROM airtable_field_mappings; DELETE FROM airtable_field_directions')
    insert.run('m1', 'fldNotes', 'Notes', 'notes')
    insert.run('m2', 'fldNotes', 'Notes', 'notes_copie')
    push.run('dyn:notes_copie')   // `notes` reste en 'pull' (défaut)

    const out = buildColumnMap('envois', {})
    assert.deepEqual(Object.entries(out).filter(([, f]) => f === 'Notes'), [['notes_copie', 'Notes']])
  })

  test('champs distincts : les deux colonnes poussent', () => {
    db.exec('DELETE FROM airtable_field_mappings; DELETE FROM airtable_field_directions')
    insert.run('m1', 'fldNotes', 'Notes', 'notes')
    insert.run('m2', 'fldTrack', 'Numéro de tracking', 'tracking_number')
    push.run('dyn:notes')
    push.run('dyn:tracking_number')

    const out = buildColumnMap('envois', {})
    assert.equal(out.notes, 'Notes')
    assert.equal(out.tracking_number, 'Numéro de tracking')
  })
})
