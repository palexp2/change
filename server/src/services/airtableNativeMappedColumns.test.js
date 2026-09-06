// Résolution du vendeur d'un projet importé d'Airtable.
//
// La colonne `projects.vendeur_ref` ne porte pas la valeur Airtable mais une
// référence Boréal (`employee:<id>` / `company:<id>`). Le nom importé doit donc
// être résolu — en préférant un enregistrement DÉCLARÉ vendeur à un homonyme,
// et en gardant le nom brut quand rien ne correspond (le champ montre alors ce
// que dit Airtable au lieu de rester vide).

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-native-mapped-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT,
  active INTEGER DEFAULT 1, is_salesperson INTEGER DEFAULT 0, airtable_id TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT, is_vendeur_orisha INTEGER DEFAULT 0,
  airtable_id TEXT, deleted_at TEXT
)`)
db.exec(`DELETE FROM employees`)
db.exec(`DELETE FROM companies`)
db.prepare('INSERT INTO employees (id, first_name, last_name, active, is_salesperson, airtable_id) VALUES (?,?,?,?,?,?)')
  .run('emp-vendeur', 'Philippe', 'Chabot', 1, 1, 'recEMP1234567890')
db.prepare('INSERT INTO employees (id, first_name, last_name, active, is_salesperson) VALUES (?,?,?,?,?)')
  .run('emp-ancien', 'Frédéric', 'Carrier', 0, 0)
db.prepare('INSERT INTO companies (id, name, is_vendeur_orisha) VALUES (?,?,?)')
  .run('comp-vendeur', 'CT greenhouse', 1)
db.prepare('INSERT INTO companies (id, name, is_vendeur_orisha) VALUES (?,?,?)')
  .run('comp-cliente', 'Frédéric Carrier', 0)

const { resolveProjectVendeurRef, resolveRefValue, nativeMappedColumn } =
  await import('./airtableNativeMappedColumns.js')

test('nom d’un employé vendeur → référence employé', () => {
  assert.equal(resolveProjectVendeurRef('Philippe Chabot'), 'employee:emp-vendeur')
  // Un lookup Airtable renvoie un tableau, et la casse ne doit rien changer.
  assert.equal(resolveProjectVendeurRef(['philippe chabot']), 'employee:emp-vendeur')
})

test('nom d’une entreprise vendeur → référence entreprise', () => {
  assert.equal(resolveProjectVendeurRef(['CT Greenhouse']), 'company:comp-vendeur')
})

test('homonyme : l’employé passe avant l’entreprise cliente', () => {
  assert.equal(resolveProjectVendeurRef('Frédéric Carrier'), 'employee:emp-ancien')
})

test('nom inconnu → conservé tel quel, jamais vidé', () => {
  assert.equal(resolveProjectVendeurRef('Serres Guy Tessier'), 'Serres Guy Tessier')
  assert.equal(resolveProjectVendeurRef(['']), null)
  assert.equal(resolveProjectVendeurRef(null), null)
})

test('record ID Airtable résolu par airtable_id, sinon rien à écrire', () => {
  assert.equal(resolveProjectVendeurRef(['recEMP1234567890']), 'employee:emp-vendeur')
  assert.equal(resolveProjectVendeurRef(['recINCONNU1234567']), null)
})

test('registre : vendeur_ref est mappable, en import seulement', () => {
  const spec = nativeMappedColumn('projects', 'vendeur_ref')
  assert.equal(spec.pull_only, true)
  assert.equal(spec.ref_resolver, 'project_vendeur')
  assert.equal(nativeMappedColumn('projects', 'name'), null)
})

test('résolveur inconnu : undefined (conversion normale côté appelant)', () => {
  assert.equal(resolveRefValue('inexistant', 'Philippe Chabot'), undefined)
  assert.equal(resolveRefValue('project_vendeur', 'Philippe Chabot'), 'employee:emp-vendeur')
})
