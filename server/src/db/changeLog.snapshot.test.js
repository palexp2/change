// Le snapshot client ne transporte pas les colonnes des champs supprimés.
//
// Ce que ces tests verrouillent :
//   1. un champ supprimé (corbeille) sort du snapshot — c'était 28 % du payload
//      (17,8 Mo sur 63) au moment où la règle a été posée ;
//   2. une exception de snapshotFields.js y reste — c'est le filet des colonnes
//      qu'un bout de code client lit encore en dur malgré la suppression ;
//   3. les colonnes de structure (id, dates, deleted_at) ne partent jamais ;
//   4. restaurer le champ le fait revenir.

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-snapshot-fields-${process.pid}.db`)

const db = (await import('./database.js')).default
const { initSchema } = await import('./schema.js')
initSchema()
// `purged_fields` naît d'une migration (011) ; on la crée ici plutôt que de
// jouer tout le registre de migrations sur une base neuve.
const { up: creerPurgedFields } = await import('./migrations/011-purged-fields.js')
creerPurgedFields(db)


const { getCachedTableSpec, invalidateColumnsCache } = await import('./changeLog.js')

const { isSnapshotKept } = await import('./snapshotFields.js')

const colonnes = (table) => new Set(getCachedTableSpec(table).columns)

// Colonne physique quelconque de `contacts`, hors exceptions : on la supprime en
// tant que champ et on vérifie qu'elle disparaît du snapshot.
const CIBLE = db.pragma('table_info(contacts)')
  .map(c => c.name)
  .find(c => !isSnapshotKept('contacts', c))

function supprimerChamp(table, column) {
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, deleted_at)
    VALUES (?, ?, ?, ?, 'text', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(erp_table, column_name) DO UPDATE SET deleted_at = excluded.deleted_at
  `).run(`${table}-${column}`, table, column, column)
  invalidateColumnsCache()
}

test('un champ supprimé sort du snapshot', () => {
  assert.ok(CIBLE, 'la table contacts doit avoir une colonne à supprimer')
  assert.ok(colonnes('contacts').has(CIBLE), 'colonne présente avant suppression')

  supprimerChamp('contacts', CIBLE)
  assert.ok(!colonnes('contacts').has(CIBLE))
})

test('la colonne reste dans la table — seul le snapshot l\'ignore', () => {
  assert.ok(db.pragma('table_info(contacts)').some(c => c.name === CIBLE))
})

test('une exception de snapshotFields reste envoyée', () => {
  // `date_commande` est dans SNAPSHOT_KEEP.orders : Priorité d'assemblage
  // l'affiche et trie dessus, hors du portier des champs.
  supprimerChamp('orders', 'date_commande')
  assert.ok(colonnes('orders').has('date_commande'))
})

test('les liens de commande et libellés récents restent disponibles après suppression', () => {
  for (const [table, column] of [
    ['order_items', 'order_id'], ['purchases', 'at_id'],
    ['purchases', 'numero_de_commande'], ['returns', 'autonumber'],
  ]) {
    // Certains libellés Airtable sont ajoutés par migration, hors initSchema.
    if (!db.pragma(`table_info(${table})`).some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
    supprimerChamp(table, column)
    assert.ok(colonnes(table).has(column), `${table}.${column} doit rester`)
  }
})

test('les colonnes de structure ne partent jamais', () => {
  for (const c of ['id', 'created_at', 'updated_at']) {
    if (!db.pragma('table_info(contacts)').some(x => x.name === c)) continue
    supprimerChamp('contacts', c)
    assert.ok(colonnes('contacts').has(c), `${c} doit rester`)
  }
})

test('un champ purgé (pierre tombale) sort aussi du snapshot', () => {
  // Une base neuve n'a que les colonnes structurelles des billets : créer
  // explicitement un champ de donnée, comme le fait l'éditeur de champs.
  const autre = 'cf_snapshot_purge_test'
  db.exec(`ALTER TABLE tickets ADD COLUMN ${autre} TEXT`)
  invalidateColumnsCache()
  assert.ok(colonnes('tickets').has(autre))
  db.prepare(`INSERT INTO purged_fields (erp_table, column_name, label) VALUES (?, ?, ?)`)
    .run('tickets', autre, autre)
  invalidateColumnsCache()
  assert.ok(!colonnes('tickets').has(autre))
})

test('restaurer le champ le fait revenir dans le snapshot', () => {
  db.prepare(`UPDATE custom_fields SET deleted_at = NULL WHERE erp_table='contacts' AND column_name=?`).run(CIBLE)
  invalidateColumnsCache()
  assert.ok(colonnes('contacts').has(CIBLE))
})

// ── Empreinte des champs calculés ────────────────────────────────────────────
//
// Changer la DÉFINITION d'un rollup (ou d'une formule) recalcule toutes les
// lignes sans en modifier aucune : le delta est vide. Sans empreinte dédiée,
// la signature du snapshot ne bougeait pas et le cache du navigateur gardait
// les anciennes valeurs — le symptôme : une colonne rollup restée vide.
test('changer la définition d\'un rollup change l\'empreinte des calculs', () => {
  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind,
                               rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg)
    VALUES ('cf-test-rollup', 'contacts', 'Rollup test', 'cf_rollup_test', 'text', 'rollup',
            'tasks', 'contact_id', 'title', 'ARRAYUNIQUE')
    ON CONFLICT(erp_table, column_name) DO UPDATE SET kind = excluded.kind
  `).run()
  invalidateColumnsCache()
  const avant = getCachedTableSpec('contacts').computedSignature
  assert.ok(avant, 'une table à champ calculé porte une empreinte')

  db.prepare(`UPDATE custom_fields SET rollup_agg='COUNT' WHERE id='cf-test-rollup'`).run()
  invalidateColumnsCache()
  assert.notEqual(getCachedTableSpec('contacts').computedSignature, avant)
})

test('sans changement de définition, l\'empreinte est stable', () => {
  const a = getCachedTableSpec('contacts').computedSignature
  invalidateColumnsCache()
  assert.equal(getCachedTableSpec('contacts').computedSignature, a)
})
