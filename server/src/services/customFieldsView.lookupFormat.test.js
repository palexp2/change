// `inferLookupResultType` : le format d'un lookup n'est pas un choix, il vient
// du champ récupéré dans la table liée (la modale de champ ne le propose plus).

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-lookupformat-${process.pid}.db`)

const db = (await import('../db/database.js')).default
db.exec(`CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,
  revenu REAL,            -- colonne native numérique
  created_at TEXT,        -- date rangée en TEXT
  date_signature TEXT,
  site_url TEXT,
  cf_total REAL,          -- champ perso « Devise »
  cf_ratio REAL,          -- champ perso « Pourcentage »
  cf_echeance TEXT,       -- champ perso « Date »
  cf_note TEXT            -- champ perso « Texte » (contient une URL)
)`)
db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, erp_table TEXT, column_name TEXT, name TEXT,
  kind TEXT, type TEXT, result_type TEXT, options TEXT, deleted_at TEXT
)`)

const ins = db.prepare(
  `INSERT INTO custom_fields (id, erp_table, column_name, name, kind, type, result_type)
   VALUES (?,?,?,?,?,?,?)`
)
ins.run('cf1', 'companies', 'cf_total', 'Total', 'data', 'currency', null)
ins.run('cf2', 'companies', 'cf_ratio', 'Ratio', 'data', 'percent', null)
ins.run('cf3', 'companies', 'cf_echeance', 'Échéance', 'data', 'date', null)
ins.run('cf4', 'companies', 'cf_note', 'Note', 'data', 'text', null)

const { inferLookupResultType } = await import('./customFieldsView.js')

test('le type du champ récupéré fait foi', () => {
  assert.equal(inferLookupResultType('companies', 'cf_total'), 'number')
  assert.equal(inferLookupResultType('companies', 'cf_ratio'), 'percent')
  assert.equal(inferLookupResultType('companies', 'cf_echeance'), 'date')
  assert.equal(inferLookupResultType('companies', 'cf_note'), 'text')
})

test('colonne native : type déclaré, puis nom de colonne pour les dates', () => {
  assert.equal(inferLookupResultType('companies', 'name'), 'text')
  assert.equal(inferLookupResultType('companies', 'revenu'), 'number')
  assert.equal(inferLookupResultType('companies', 'created_at'), 'date')
  assert.equal(inferLookupResultType('companies', 'date_signature'), 'date')
  assert.equal(inferLookupResultType('companies', 'site_url'), 'url')
})

test('re-typage d\'un champ natif : la personnalisation prime sur le type déclaré', () => {
  ins.run('cf5', 'companies', 'name', '', 'native', '', null)
  assert.equal(inferLookupResultType('companies', 'name'), 'text')
  db.prepare(`UPDATE custom_fields SET type='url' WHERE id='cf5'`).run()
  assert.equal(inferLookupResultType('companies', 'name'), 'url')
})

test('champ supprimé, table ou colonne inconnue → texte, jamais d\'interpolation SQL', () => {
  db.prepare(`UPDATE custom_fields SET deleted_at='2026-09-09' WHERE id='cf1'`).run()
  assert.equal(inferLookupResultType('companies', 'cf_total'), 'number')  // colonne REAL
  assert.equal(inferLookupResultType('inconnue', 'name'), 'text')
  assert.equal(inferLookupResultType('companies', 'name) --'), 'text')
  assert.equal(inferLookupResultType(null, null), 'text')
})
