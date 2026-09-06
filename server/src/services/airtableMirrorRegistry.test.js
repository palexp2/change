// Registre du miroir Airtable — les deux logiques qui cassent en silence :
// l'ordre de dépendance des miroirs, et la préservation d'une décision humaine
// lors d'un rafraîchissement.
//
// Ni l'une ni l'autre ne se voit à l'œil nu : un ordre topologique cassé
// n'échoue pas, il importe simplement un record avant son parent et laisse une
// clé étrangère à NULL ; et un rafraîchissement qui écrase une décision ne
// laisse aucune trace. D'où ces tests.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-mirror-registry-${process.pid}.db`)

const db = (await import('../db/database.js')).default

// schema.js n'est pas exécuté en test : on rejoue la DDL de la migration 004.
const migration = await import('../db/migrations/004-airtable-mirror-registry.js')
migration.up(db)

const { readMirrors, registryCounters } = await import('./airtableMirrorRegistry.js')

const addMirror = (id, { status = 'mirrored', dependsOn = [], erpTable = null, decidedBy = 'backfill' } = {}) =>
  db.prepare(`
    INSERT OR REPLACE INTO airtable_mirrors
      (id, base_id, table_id, erp_table, status, depends_on, decided_by)
    VALUES (?, 'appTest', ?, ?, ?, ?, ?)
  `).run(id, `tbl_${id}`, erpTable || id, status, JSON.stringify(dependsOn), decidedBy)

const addField = (mirrorId, fieldName, { state = 'unmapped', column = null } = {}) =>
  db.prepare(`
    INSERT OR REPLACE INTO airtable_field_map
      (id, mirror_id, field_name, erp_column, state)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${mirrorId}:${fieldName}`, mirrorId, fieldName, column, state)

const reset = () => {
  db.exec('DELETE FROM airtable_field_map')
  db.exec('DELETE FROM airtable_mirrors')
}

test('readMirrors ordonne les miroirs après leurs dépendances', () => {
  reset()
  // Déclarés à l'envers exprès : sans tri, l'ordre alphabétique donnerait
  // envois avant orders avant companies — soit l'inverse de ce qu'il faut.
  addMirror('envois', { dependsOn: ['orders', 'adresses'] })
  addMirror('orders', { dependsOn: ['companies', 'projets'] })
  addMirror('projets', { dependsOn: ['companies'] })
  addMirror('companies')
  addMirror('adresses', { dependsOn: ['companies'] })

  const order = readMirrors().map(m => m.id)
  const pos = id => order.indexOf(id)

  assert.equal(order.length, 5, 'aucun miroir ne doit disparaître du tri')
  assert.ok(pos('companies') < pos('projets'), 'companies avant projets')
  assert.ok(pos('companies') < pos('orders'), 'companies avant orders')
  assert.ok(pos('projets') < pos('orders'), 'projets avant orders')
  assert.ok(pos('orders') < pos('envois'), 'orders avant envois')
  assert.ok(pos('adresses') < pos('envois'), 'adresses avant envois')
})

test('readMirrors survit à une dépendance absente ou hors périmètre', () => {
  reset()
  // `projets` est en pause : il ne fait pas partie du périmètre par défaut, donc
  // orders référence une dépendance introuvable. Le tri ne doit pas pour autant
  // faire disparaître orders — c'est exactement le cas d'un miroir mis en pause.
  addMirror('orders', { dependsOn: ['companies', 'projets', 'inexistant'] })
  addMirror('companies')
  addMirror('projets', { status: 'paused' })

  const order = readMirrors({ statuses: ['mirrored'] }).map(m => m.id)
  assert.deepEqual(order, ['companies', 'orders'])
})

test('readMirrors ne boucle pas sur une dépendance circulaire', () => {
  reset()
  addMirror('a', { dependsOn: ['b'] })
  addMirror('b', { dependsOn: ['a'] })

  // Le contrat est la terminaison sans perte, pas un ordre particulier : un
  // cycle n'a pas d'ordre correct, mais il ne doit ni pendre ni escamoter un
  // miroir.
  const order = readMirrors().map(m => m.id)
  assert.equal(order.length, 2)
  assert.deepEqual([...order].sort(), ['a', 'b'])
})

test('readMirrors ne retient que les statuts demandés', () => {
  reset()
  addMirror('vivant', { status: 'mirrored' })
  addMirror('en_pause', { status: 'paused' })
  addMirror('exclu', { status: 'excluded' })
  addMirror('sans_decision', { status: 'undecided' })

  assert.deepEqual(readMirrors().map(m => m.id).sort(), ['en_pause', 'vivant'],
    'par défaut : mirroré + en pause, jamais exclu ni sans décision')
  assert.deepEqual(readMirrors({ statuses: ['undecided'] }).map(m => m.id), ['sans_decision'])
})

test('registryCounters compte les états qui doivent tomber à zéro', () => {
  reset()
  addMirror('m1', { status: 'mirrored' })
  addMirror('m2', { status: 'undecided' })
  addField('m1', 'Nom', { state: 'mirrored', column: 'name' })
  addField('m1', 'Statut', { state: 'core', column: 'status' })
  addField('m1', 'Oublié')            // unmapped par défaut
  addField('m1', 'Retiré', { state: 'excluded' })

  const c = registryCounters()
  assert.equal(c.mirrors.mirrored, 1)
  assert.equal(c.mirrors.undecided, 1)
  assert.equal(c.fields.mirrored, 1)
  assert.equal(c.fields.core, 1)
  assert.equal(c.fields.unmapped, 1)
  assert.equal(c.fields.excluded, 1)
})

test('un champ Airtable n’apparaît qu’une fois par miroir', () => {
  reset()
  addMirror('m1')
  addField('m1', 'Nom', { column: 'name' })
  // Deux miroirs peuvent porter un champ homonyme — l'unicité est par miroir.
  addMirror('m2')
  addField('m2', 'Nom', { column: 'name' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM airtable_field_map').get().n, 2)

  assert.throws(
    () => db.prepare(`
      INSERT INTO airtable_field_map (id, mirror_id, field_name, state)
      VALUES ('doublon', 'm1', 'Nom', 'unmapped')
    `).run(),
    /UNIQUE constraint failed/,
    'un second mapping du même champ Airtable dans le même miroir doit être refusé'
  )
})

test('supprimer un miroir emporte ses champs', () => {
  reset()
  addMirror('m1')
  addField('m1', 'Nom', { column: 'name' })
  addField('m1', 'Statut', { column: 'status' })

  db.exec("DELETE FROM airtable_mirrors WHERE id='m1'")
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM airtable_field_map').get().n, 0,
    'ON DELETE CASCADE doit laisser zéro champ orphelin'
  )
})

test('les états invalides sont refusés par la base', () => {
  reset()
  addMirror('m1')
  assert.throws(
    () => db.prepare(`
      INSERT INTO airtable_mirrors (id, base_id, table_id, status)
      VALUES ('x', 'appTest', 'tblX', 'peut-etre')
    `).run(),
    /CHECK constraint failed/,
    'un statut de miroir hors liste doit être refusé'
  )
  assert.throws(
    () => addField('m1', 'Champ', { state: 'a-voir' }),
    /CHECK constraint failed/,
    'un état de champ hors liste doit être refusé'
  )
  assert.throws(
    () => db.prepare(`
      INSERT INTO airtable_field_map (id, mirror_id, field_name, direction)
      VALUES ('y', 'm1', 'Autre', 'peut-etre')
    `).run(),
    /CHECK constraint failed/,
    'un sens de sync hors liste doit être refusé'
  )
})
