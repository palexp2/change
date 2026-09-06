// Résolution « identifiant → fiche » des champs lien : un id ERP ou un record
// ID Airtable doit ramener le même enregistrement, avec son libellé et l'URL de
// sa fiche.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-recordlinks-${process.pid}.db`)

const db = (await import('../db/database.js')).default
// schema.js n'est pas exécuté en test : on recrée les tables utilisées.
db.exec(`CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT, city TEXT, airtable_id TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, order_number TEXT, company_id TEXT, airtable_id TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS paies (
  id TEXT PRIMARY KEY, number TEXT, period_end TEXT, airtable_id TEXT
)`)

db.prepare('INSERT INTO companies (id, name, city, airtable_id) VALUES (?,?,?,?)')
  .run('c-1', 'Ferme Test', 'Québec', 'recAAAAAAAAAAAAAA')
db.prepare('INSERT INTO orders (id, order_number, company_id, airtable_id) VALUES (?,?,?,?)')
  .run('o-1', '634', 'c-1', 'recBBBBBBBBBBBBBB')
db.prepare('INSERT INTO paies (id, number, period_end, airtable_id) VALUES (?,?,?,?)')
  .run('p-1', '2026-07', '2026-07-15', 'recCCCCCCCCCCCCCC')

const { resolveRecordKeys, searchRecords } = await import('./recordLinks.js')

test('un record ID Airtable est résolu sans indice de table', () => {
  const out = resolveRecordKeys(['recBBBBBBBBBBBBBB'])
  assert.deepEqual(out['recBBBBBBBBBBBBBB'], {
    table: 'orders', id: 'o-1', label: '#634', sub: 'Ferme Test', url: '/orders/o-1',
  })
})

test('plusieurs clés de tables différentes en un appel', () => {
  const out = resolveRecordKeys(['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB'])
  assert.equal(out['recAAAAAAAAAAAAAA'].table, 'companies')
  assert.equal(out['recAAAAAAAAAAAAAA'].label, 'Ferme Test')
  assert.equal(out['recBBBBBBBBBBBBBB'].table, 'orders')
})

test('un id ERP est résolu quand la table cible est indiquée', () => {
  const out = resolveRecordKeys(['c-1'], { hint: 'companies' })
  assert.equal(out['c-1'].url, '/companies/c-1')
})

test('un id ERP sans indice de table ne résout rien (UUID non discriminant)', () => {
  assert.deepEqual(resolveRecordKeys(['c-1']), {})
})

test('une table sans fiche détail résout un libellé mais aucune URL', () => {
  const out = resolveRecordKeys(['recCCCCCCCCCCCCCC'])
  assert.equal(out['recCCCCCCCCCCCCCC'].label, 'Paie 2026-07')
  assert.equal(out['recCCCCCCCCCCCCCC'].url, null)
})

test('un record ID inconnu est simplement absent du résultat', () => {
  assert.deepEqual(resolveRecordKeys(['recZZZZZZZZZZZZZZ']), {})
})

test('clés vides / doublons tolérés', () => {
  const out = resolveRecordKeys(['recBBBBBBBBBBBBBB', '', null, 'recBBBBBBBBBBBBBB'])
  assert.equal(Object.keys(out).length, 1)
})

// ── Résolution par LIBELLÉ (champs natifs affichés « Lien vers … ») ──────────

test('un libellé ne résout rien sans by_label', () => {
  assert.deepEqual(resolveRecordKeys(['Ferme Test'], { hint: 'companies' }), {})
})

test('un libellé résout la fiche quand byLabel est demandé', () => {
  const out = resolveRecordKeys(['Ferme Test'], { hint: 'companies', byLabel: true })
  assert.deepEqual(out['Ferme Test'], {
    table: 'companies', id: 'c-1', label: 'Ferme Test', sub: 'Québec', url: '/companies/c-1',
  })
})

test('la résolution par libellé ignore la casse', () => {
  const out = resolveRecordKeys(['ferme test'], { hint: 'companies', byLabel: true })
  assert.equal(out['ferme test'].id, 'c-1')
})

test('byLabel sans table cible ne cherche aucun libellé', () => {
  assert.deepEqual(resolveRecordKeys(['Ferme Test'], { byLabel: true }), {})
})

test('un libellé inconnu reste absent du résultat', () => {
  assert.deepEqual(resolveRecordKeys(['Ferme Inconnue'], { hint: 'companies', byLabel: true }), {})
})

test('les identifiants gardent la priorité sur les libellés', () => {
  const out = resolveRecordKeys(['c-1', 'Ferme Test'], { hint: 'companies', byLabel: true })
  assert.equal(out['c-1'].id, 'c-1')
  assert.equal(out['Ferme Test'].id, 'c-1')
})

// ── searchRecords : les candidats à une association ─────────────────────────

test('la recherche rend les deux identités et l\'URL de la fiche', () => {
  const out = searchRecords('companies', 'ferme')
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    id: 'c-1', airtable_id: 'recAAAAAAAAAAAAAA', label: 'Ferme Test',
    sub: 'Québec', url: '/companies/c-1',
  })
})

test('la recherche porte aussi sur le contexte (sub)', () => {
  // '#634' ne contient pas 'ferme' : c'est le nom de l'entreprise, affiché en
  // contexte de la commande, qui doit la faire trouver.
  assert.deepEqual(searchRecords('orders', 'ferme').map(r => r.id), ['o-1'])
})

test('sans terme, la recherche liste la table (bornée)', () => {
  assert.deepEqual(searchRecords('companies', '').map(r => r.id), ['c-1'])
  assert.equal(searchRecords('companies', '', 0).length, 1)
})

test('une table hors registre ne rend rien (pas de SQL construit)', () => {
  assert.deepEqual(searchRecords('companies; DROP TABLE orders', ''), [])
  assert.deepEqual(searchRecords(null, ''), [])
})

test('un terme sans correspondance rend une liste vide', () => {
  assert.deepEqual(searchRecords('companies', 'zzz'), [])
})
