// Moteur unique de sync Airtable — les deux comportements qu'il apporte et que
// les vingt fonctions historiques n'avaient pas, plus les transformations.
//
// L'écriture différentielle et la purge tolérante sont exactement le genre de
// chose qui « marche » en apparence même quand elle est cassée : un upsert qui
// réécrit tout produit le bon résultat (juste 240 000 mutations inutiles), et
// une purge qui plante est avalée par un catch. Sans test, une régression y
// serait invisible.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-mirror-engine-${process.pid}.db`)

const db = (await import('../db/database.js')).default

// Deux tables jouets : une « parent » mirroirée et une « enfant » qui la
// référence, pour éprouver la purge bloquée par une clé étrangère.
db.exec(`
  CREATE TABLE IF NOT EXISTS t_parent (
    id TEXT PRIMARY KEY,
    airtable_id TEXT UNIQUE,
    label TEXT,
    qty INTEGER,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS t_child (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES t_parent(id)
  );
`)

const { TRANSFORMS, CORE_PLANS, __test } = await import('./airtableMirrorEngine.js')

const reset = () => { db.exec('DELETE FROM t_child'); db.exec('DELETE FROM t_parent') }

const seedParent = (airtableId, { label = 'a', qty = 1 } = {}) =>
  db.prepare('INSERT INTO t_parent (id, airtable_id, label, qty, updated_at) VALUES (?,?,?,?,?)')
    .run(`id_${airtableId}`, airtableId, label, qty, '2020-01-01T00:00:00.000Z')

const readParent = (airtableId) =>
  db.prepare('SELECT * FROM t_parent WHERE airtable_id=?').get(airtableId)

// ── Écriture différentielle ─────────────────────────────────────────────────

test('un record identique ne provoque AUCUNE écriture', () => {
  reset()
  seedParent('rec1', { label: 'Cabane', qty: 3 })
  const before = readParent('rec1').updated_at

  const outcome = __test.differentialUpsert('t_parent', 'rec1', { label: 'Cabane', qty: 3 })

  assert.equal(outcome, 'unchanged')
  assert.equal(readParent('rec1').updated_at, before,
    "updated_at ne doit pas bouger — c'est lui qui déclenche le trafic fantôme")
})

test('seules les colonnes réellement changées sont écrites', () => {
  reset()
  seedParent('rec1', { label: 'Cabane', qty: 3 })

  const outcome = __test.differentialUpsert('t_parent', 'rec1', { label: 'Serre', qty: 3 })

  assert.equal(outcome, 'updated')
  const row = readParent('rec1')
  assert.equal(row.label, 'Serre')
  assert.equal(row.qty, 3)
  assert.notEqual(row.updated_at, '2020-01-01T00:00:00.000Z', 'un vrai changement horodate')
})

test('un record absent est inséré', () => {
  reset()
  const outcome = __test.differentialUpsert('t_parent', 'recNeuf', { label: 'Neuf', qty: 7 })
  assert.equal(outcome, 'imported')
  const row = readParent('recNeuf')
  assert.equal(row.label, 'Neuf')
  assert.equal(row.qty, 7)
})

test("l'essai à blanc n'écrit rien du tout", () => {
  reset()
  seedParent('rec1', { label: 'Cabane', qty: 3 })

  assert.equal(__test.differentialUpsert('t_parent', 'rec1', { label: 'Serre' }, { dryRun: true }), 'updated')
  assert.equal(readParent('rec1').label, 'Cabane', 'la valeur ne doit pas avoir bougé')

  assert.equal(__test.differentialUpsert('t_parent', 'recX', { label: 'X' }, { dryRun: true }), 'imported')
  assert.equal(readParent('recX'), undefined, 'aucune ligne ne doit avoir été créée')
})

test('0 stocké et "0" entrant ne comptent pas comme un changement', () => {
  reset()
  // SQLite rend un INTEGER pour une colonne entière ; une transformation peut
  // rendre une chaîne. Sans normalisation, chaque sync réécrirait la ligne.
  seedParent('rec1', { label: 'x', qty: 0 })
  assert.equal(__test.differentialUpsert('t_parent', 'rec1', { qty: '0' }), 'unchanged')
})

test('null et chaîne vide ne sont pas confondus avec une valeur', () => {
  reset()
  seedParent('rec1', { label: null, qty: 1 })
  assert.equal(__test.differentialUpsert('t_parent', 'rec1', { label: null }), 'unchanged')
  assert.equal(__test.differentialUpsert('t_parent', 'rec1', { label: '' }), 'updated',
    "'' est une valeur différente de null — le sync le distingue, le test aussi")
})

// ── Purge tolérante ─────────────────────────────────────────────────────────

test('les orphelins non référencés sont purgés', () => {
  reset()
  seedParent('recGarde')
  seedParent('recOrphelin')

  const res = __test.purgeOrphansTolerant('t_parent', [{ id: 'recGarde' }])

  assert.equal(res.purged, 1)
  assert.deepEqual(res.blocked, [])
  assert.equal(readParent('recOrphelin'), undefined)
  assert.ok(readParent('recGarde'), 'un record encore présent dans Airtable reste')
})

test('un orphelin encore référencé est SIGNALÉ, pas supprimé, et ne bloque pas les autres', () => {
  reset()
  seedParent('recRefere')
  seedParent('recLibre')
  db.prepare('INSERT INTO t_child (id, parent_id) VALUES (?,?)').run('c1', 'id_recRefere')

  // Les deux ont disparu d'Airtable. L'un est retenu par une clé étrangère.
  const res = __test.purgeOrphansTolerant('t_parent', [])

  assert.deepEqual(res.blocked, ['recRefere'])
  assert.equal(res.purged, 1, "l'orphelin libre doit tout de même partir")
  assert.ok(readParent('recRefere'), 'le référencé survit — le supprimer casserait son référent')
  assert.equal(readParent('recLibre'), undefined)
})

test('detachOnDelete : la référence est vidée et la ligne part quand même', () => {
  reset()
  seedParent('recArticle')
  db.prepare('INSERT INTO t_child (id, parent_id) VALUES (?,?)').run('serie1', 'id_recArticle')

  const res = __test.purgeOrphansTolerant('t_parent', [], { detachOnDelete: [['t_child', 'parent_id']] })

  assert.deepEqual(res, { purged: 1, blocked: [] })
  assert.equal(readParent('recArticle'), undefined)
  assert.equal(db.prepare('SELECT parent_id FROM t_child WHERE id=?').get('serie1').parent_id, null,
    'la référence survit, détachée — comme Airtable vide le lien')
})

test('le plan order_items détache les numéros de série', () => {
  assert.deepEqual(CORE_PLANS.order_items.detachOnDelete, [['serial_numbers', 'order_item_id']])
})

test('aucun orphelin : aucune écriture, aucun signalement', () => {
  reset()
  seedParent('rec1')
  const res = __test.purgeOrphansTolerant('t_parent', [{ id: 'rec1' }])
  assert.deepEqual(res, { purged: 0, blocked: [] })
})

// ── Transformations ─────────────────────────────────────────────────────────

test('int0 rend 0 pour un champ vide, absent ou illisible', () => {
  assert.equal(TRANSFORMS.int0({}, 'Qté'), 0, 'champ absent')
  assert.equal(TRANSFORMS.int0({ 'Qté': null }, 'Qté'), 0)
  assert.equal(TRANSFORMS.int0({ 'Qté': '' }, 'Qté'), 0)
  assert.equal(TRANSFORMS.int0({ 'Qté': 'abc' }, 'Qté'), 0)
  assert.equal(TRANSFORMS.int0({ 'Qté': '12' }, 'Qté'), 12)
  assert.equal(TRANSFORMS.int0({ 'Qté': 12.7 }, 'Qté'), 12, 'tronque, comme parseInt')
})

test('number rend null pour un champ vide — un prix absent n’est pas un prix nul', () => {
  assert.equal(TRANSFORMS.number({}, 'Prix'), null)
  assert.equal(TRANSFORMS.number({ Prix: '' }, 'Prix'), null)
  assert.equal(TRANSFORMS.number({ Prix: 'abc' }, 'Prix'), null)
  assert.equal(TRANSFORMS.number({ Prix: '12.5' }, 'Prix'), 12.5)
  assert.equal(TRANSFORMS.number({ Prix: 0 }, 'Prix'), 0, '0 est une valeur, pas une absence')
})

test('text nettoie comme le sync historique', () => {
  assert.equal(TRANSFORMS.text({ N: '  Serre  ' }, 'N'), 'Serre')
  assert.equal(TRANSFORMS.text({ N: '   ' }, 'N'), null, "une chaîne d'espaces devient null")
  assert.equal(TRANSFORMS.text({ N: ['a', 'b'] }, 'N'), 'a, b')
  assert.equal(TRANSFORMS.text({}, 'N'), null)
})

// ── Achats : la seule colonne que le mapping champ-à-champ ne peut pas dire ──
//
// Le plan cœur des achats est VIDE depuis la migration 035 (« supprime tous les
// champs Airtable gérés en code définitivement ») : product_id, reference,
// order_date, received_date, qty_ordered, unit_cost et notes ont été droppées,
// après supplier et status (032), et `qty_received` à son tour (036). Il ne
// reste au `derive` qu'un travail : sortir DEUX colonnes (nom canonique
// QuickBooks + Id vendor) d'un SEUL champ lié.

const achatsDerive = (fields, opts) =>
  CORE_PLANS.achats.derive(fields, { id: 'rec1', fields }, {}, opts)

test('achats : le plan cœur ne mappe plus aucun champ', () => {
  assert.deepEqual(CORE_PLANS.achats.fields, {})
})

test('achats : le derive n’écrit QUE les deux colonnes de fournisseur', () => {
  // La quantité reçue est partie avec sa colonne (036) : plus aucun champ
  // Airtable ne peut être écrit hors du fournisseur lié.
  assert.deepEqual(
    Object.keys(achatsDerive({ 'Qté reçue': '12' })),
    ['supplier_vendor_name', 'supplier_qb_vendor_id'],
  )
})

test('achats : le fournisseur lié donne le nom canonique QB et son Id', () => {
  const ctx = { vendors: new Map([['recV1', { name: 'Mouser Electronics', qb_vendor_id: '42' }]]) }
  const lie = achatsDerive({ Fournisseur: ['recV1'] }, { ctx })
  assert.deepEqual(
    [lie.supplier_vendor_name, lie.supplier_qb_vendor_id],
    ['Mouser Electronics', '42'],
  )
  const inconnu = achatsDerive({ Fournisseur: ['recINCONNU'] }, { ctx })
  assert.equal(inconnu.supplier_vendor_name, null)
  assert.equal(inconnu.supplier_qb_vendor_id, null)
})

test('intClean0 / floatClean0 nettoient le texte et retombent sur 0', () => {
  assert.equal(TRANSFORMS.intClean0({ Q: '1 234 unités' }, 'Q'), 1234)
  assert.equal(TRANSFORMS.intClean0({ Q: '12.6' }, 'Q'), 13, 'arrondit, comme toInt')
  assert.equal(TRANSFORMS.intClean0({}, 'Q'), 0)
  assert.equal(TRANSFORMS.floatClean0({ P: '$12.50' }, 'P'), 12.5)
  assert.equal(TRANSFORMS.floatClean0({ P: 'n/a' }, 'P'), 0)
  assert.equal(TRANSFORMS.floatClean0({ P: 0 }, 'P'), 0)
})
