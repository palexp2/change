// Changement de type d'un champ personnalisé : ce qui doit tenir même quand
// personne ne regarde.
//
//   1. les valeurs SUIVENT le type (le verrou d'avant existait parce que
//      personne ne les convertissait) ;
//   2. ce qui ne se convertit pas est COMPTÉ et rendu à l'utilisateur en
//      exemples — jamais écrasé en silence ;
//   3. passer à une sélection sans liste dérive les choix des données ;
//   4. quand l'affinité change (texte → nombre), la colonne physique est
//      refaite : sinon le champ « Nombre » trierait encore comme du texte.
import { join } from 'path'
import { tmpdir } from 'os'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-field-retype-${process.pid}.db`)

const db = (await import('../db/database.js')).default
const { initSchema } = await import('../db/schema.js')
initSchema()

const { planTypeConversion, applyTypeConversion, convertSingleValue, valueToText, sqlAffinityFor } =
  await import('./fieldTypeConvert.js')

const TABLE = 'projects'
let seq = 0

// Champ perso jetable + sa colonne physique, remplis avec `values`.
function fieldWith(type, values, { options = null, sqlType = null } = {}) {
  const col = `cf_t${++seq}`
  db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col} ${sqlType || sqlAffinityFor(type)}`)
  const id = `f-${seq}`
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source, options)
    VALUES (?, ?, ?, ?, ?, 'data', 'native', ?)
  `).run(id, TABLE, `Champ ${seq}`, col, type, options)
  const ins = db.prepare(`INSERT INTO ${TABLE} (id, name, ${col}) VALUES (?, ?, ?)`)
  const ids = []
  values.forEach((v, i) => {
    const rid = `r-${seq}-${i}`
    ins.run(rid, `rec ${i}`, v)
    ids.push(rid)
  })
  return { field: db.prepare('SELECT * FROM custom_fields WHERE id=?').get(id), col, ids }
}

const read = (col, id) => db.prepare(`SELECT [${col}] AS v FROM ${TABLE} WHERE id=?`).get(id).v

test('texte → nombre : convertit ce qui est un nombre, compte le reste', () => {
  const { field, col, ids } = fieldWith('text', ['1 234,56 $', '12', 'douze'])
  const plan = planTypeConversion(field, 'number', null)
  assert.equal(plan.filled, 3)
  assert.equal(plan.converted, 2)
  assert.equal(plan.unconvertible, 1)
  assert.deepEqual(plan.samples, [{ value: 'douze', count: 1 }])

  db.transaction(() => applyTypeConversion(field, plan))()
  assert.equal(read(col, ids[0]), 1234.56)
  assert.equal(read(col, ids[1]), 12)
  assert.equal(read(col, ids[2]), null, 'la valeur illisible est vidée, pas devinée')
})

test('l’affinité change → la colonne physique est refaite (tri numérique)', () => {
  const { field, col } = fieldWith('text', ['9', '10'])
  assert.equal(db.pragma(`table_info(${TABLE})`).find(c => c.name === col).type, 'TEXT')
  const plan = planTypeConversion(field, 'number', null)
  assert.equal(plan.rebuild, true)
  db.transaction(() => applyTypeConversion(field, plan))()
  assert.equal(db.pragma(`table_info(${TABLE})`).find(c => c.name === col).type, 'REAL')
  const order = db.prepare(`SELECT [${col}] AS v FROM ${TABLE} WHERE [${col}] IS NOT NULL ORDER BY [${col}]`).all()
  assert.deepEqual(order.map(r => r.v), [9, 10], '9 avant 10 — pas l’ordre lexicographique')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?").get(`${TABLE}_v`), 'vue recréée')
})

test('texte → sélection sans liste : les valeurs distinctes FONT les choix', () => {
  const { field, col, ids } = fieldWith('text', ['Installation', 'Remplacement', 'installation'])
  const plan = planTypeConversion(field, 'single_select', null)
  assert.equal(plan.unconvertible, 0)
  assert.deepEqual(plan.derivedOptions.choices.map(c => c.label), ['Installation', 'Remplacement'])
  db.transaction(() => applyTypeConversion(field, plan))()
  assert.equal(read(col, ids[2]), 'Installation', 'la casse est ramenée sur le libellé du choix')
})

test('texte → sélection avec liste imposée : hors liste = non convertible', () => {
  const { field } = fieldWith('text', ['Installation', 'Autre chose'])
  const opts = { choices: [{ id: 'a', label: 'Installation' }] }
  const plan = planTypeConversion(field, 'single_select', opts)
  assert.equal(plan.converted, 1)
  assert.equal(plan.unconvertible, 1)
  assert.equal(plan.samples[0].value, 'Autre chose')
})

test('durée ↔ texte fait l’aller-retour', () => {
  const { field, col, ids } = fieldWith('duration', [5400], { options: JSON.stringify({ format: 'h:mm' }) })
  const toText = planTypeConversion(field, 'text', null)
  db.transaction(() => applyTypeConversion(field, toText))()
  assert.equal(read(col, ids[0]), '1:30')

  const back = db.prepare('SELECT * FROM custom_fields WHERE id=?').get(field.id)
  back.type = 'text'
  const plan = planTypeConversion(back, 'duration', null)
  assert.equal(plan.unconvertible, 0)
  db.transaction(() => applyTypeConversion(back, plan))()
  assert.equal(read(col, ids[0]), 5400)
})

test('pourcentage ↔ nombre : la valeur ne bouge pas, seul le rendu change', () => {
  // La colonne porte le nombre de POURCENTS : passer un nombre en pourcentage
  // (et l'inverse) ne doit rien multiplier ni rien perdre en décimales.
  const { field, col, ids } = fieldWith('number', [45, 45.5])
  const toPercent = planTypeConversion(field, 'percent', null)
  assert.equal(toPercent.unconvertible, 0)
  assert.equal(toPercent.rebuild, false, 'nombre et pourcentage ont la même affinité REAL')
  db.transaction(() => applyTypeConversion(field, toPercent))()
  assert.equal(read(col, ids[0]), 45)
  assert.equal(read(col, ids[1]), 45.5)

  const asPercent = db.prepare('SELECT * FROM custom_fields WHERE id=?').get(field.id)
  asPercent.type = 'percent'
  assert.equal(valueToText(45.5, 'percent', null), '45,5\u00a0%')
  const back = planTypeConversion(asPercent, 'number', null)
  assert.equal(back.unconvertible, 0)
  db.transaction(() => applyTypeConversion(asPercent, back))()
  assert.equal(read(col, ids[1]), 45.5)
})

test('case à cocher ↔ texte : Oui/Non, et l’ambigu est refusé', () => {
  const { field, col, ids } = fieldWith('checkbox', [1, 0])
  const plan = planTypeConversion(field, 'text', null)
  db.transaction(() => applyTypeConversion(field, plan))()
  assert.equal(read(col, ids[0]), 'Oui')
  assert.equal(read(col, ids[1]), 'Non')
  assert.equal(convertSingleValue('peut-être', 'text', null, 'checkbox', null).ok, false)
})

test('vers attachement : rien n’est fabriqué, tout est signalé', () => {
  const { field } = fieldWith('text', ['facture.pdf'])
  const plan = planTypeConversion(field, 'attachment', null)
  assert.equal(plan.converted, 0)
  assert.equal(plan.unconvertible, 1)
})

test('colonne vide : aucun avertissement à afficher', () => {
  const { field } = fieldWith('text', [null, null])
  const plan = planTypeConversion(field, 'date', null)
  assert.equal(plan.filled, 0)
  assert.equal(plan.unconvertible, 0)
})

test('multi-sélection → texte joint les libellés', () => {
  assert.equal(valueToText(JSON.stringify(['A', 'B']), 'multi_select', null), 'A, B')
})

test('date : ISO et JJ/MM/AAAA passent, le mois d’abord est refusé', () => {
  assert.equal(convertSingleValue('2026-04-03', 'text', null, 'date', null).value, '2026-04-03')
  assert.equal(convertSingleValue('03/04/2026', 'text', null, 'date', null).value, '2026-04-03')
  assert.equal(convertSingleValue('4 avril 2026', 'text', null, 'date', null).ok, false)
})

test('nombre → évaluation : la note passe, hors échelle est signalé', () => {
  const { field, col, ids } = fieldWith('number', [4, 8])
  const plan = planTypeConversion(field, 'rating', null)
  assert.equal(plan.converted, 1)
  assert.equal(plan.unconvertible, 1, 'une note de 8 sur 5 est rendue à l’utilisateur')
  assert.equal(plan.rebuild, true, 'REAL → INTEGER : la colonne est refaite')
  db.transaction(() => applyTypeConversion(field, plan))()
  assert.equal(read(col, ids[0]), 4)
  assert.equal(read(col, ids[1]), null)
})

test('évaluation → texte garde le nombre d’étoiles', () => {
  assert.equal(valueToText(3, 'rating', null), '3')
  assert.equal(convertSingleValue('3', 'text', null, 'rating', null).value, 3)
})
