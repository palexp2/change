// Chaînes de texte constantes dans une formule de champ calculé.
//
// Airtable écrit ses littéraux entre guillemets doubles ("texte") ; SQLite les
// réserve aux identifiants (better-sqlite3 : SQLITE_DQS=0), donc
// CONCATENATE("https://…", id) échouait avec « no such column: https://… ».
// validateFormulaExpr traduit désormais ces littéraux en chaînes SQL, et la
// détection de mots-clés interdits ne regarde plus DANS les chaînes.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-formula-quotes-${process.pid}.db`)

const db = (await import('../db/database.js')).default
const { registerFormulaFunctions } = await import('./formulaEngine.js')
registerFormulaFunctions(db)

db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, erp_table TEXT, name TEXT, column_name TEXT, type TEXT,
  kind TEXT DEFAULT 'data', formula_expr TEXT, deleted_at TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, airtable_id TEXT, deleted_at TEXT)`)
db.prepare('INSERT OR REPLACE INTO shipments (id, airtable_id) VALUES (?, ?)').run('s1', 'recABC')

const { validateFormulaExpr, previewFormula } = await import('./customFieldsView.js')

test('un littéral entre guillemets doubles devient une chaîne SQL', () => {
  assert.equal(
    validateFormulaExpr('CONCATENATE("https://airtable.com/app/tbl/viw", airtable_id)'),
    "CONCATENATE('https://airtable.com/app/tbl/viw', airtable_id)",
  )
})

test('les apostrophes du texte sont échappées', () => {
  assert.equal(validateFormulaExpr('"L\'été"'), "'L''été'")
  assert.equal(validateFormulaExpr('"il a dit ""non"""'), "'il a dit \"non\"'")
})

test('les littéraux simple-quote passent inchangés', () => {
  assert.equal(validateFormulaExpr("IF(status = 'Gagné', total, 0)"), "IF(status = 'Gagné', total, 0)")
})

test('une chaîne non fermée est refusée avec un message clair', () => {
  assert.throws(() => validateFormulaExpr('CONCATENATE("https://x, id)'), /non fermée/)
})

test('un mot-clé interdit reste refusé hors chaîne, mais est permis dedans', () => {
  assert.throws(() => validateFormulaExpr('(SELECT 1)'), /interdit/)
  assert.throws(() => validateFormulaExpr("id ; DROP"), /interdit/)
  assert.equal(validateFormulaExpr('"?update=1"'), "'?update=1'")
})

test('aperçu : la formule concaténée renvoie bien le texte constant', () => {
  const rows = previewFormula('shipments', 'CONCATENATE("https://airtable.com/v/", airtable_id)')
  assert.equal(rows[0].value, 'https://airtable.com/v/recABC')
})
