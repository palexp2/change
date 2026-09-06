// Garde : aucune colonne retirée du snapshot ne doit être lue par une page du cache.
//
// Retirer les champs supprimés du snapshot (voir snapshotFields.js) allège le
// bootstrap d'un tiers, mais casserait silencieusement une page qui lit la colonne
// en dur sur un record du cache — un tri, un repli de libellé, un calcul : le
// portier de champs ne couvre que l'affichage piloté par les champs.
//
// Le périmètre est exactement l'ensemble des fichiers qui touchent au cache
// (`useTable`, `getRecord`, `isTableHydrated`, ou un import de dataStore) : partout
// ailleurs les données viennent de l'API, où la colonne SQL est intacte. Ce test
// rejoue l'audit à chaque `npm test`, sur l'état RÉEL de la base (lecture seule) et
// le code client d'aujourd'hui. S'il échoue, le message donne la colonne à ajouter
// à SNAPSHOT_KEEP (ou le champ à restaurer).

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { isSnapshotKept, SNAPSHOT_REVIEWED } from './snapshotFields.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(HERE, '..', '..', 'data', 'erp.db')
const CLIENT_SRC = join(HERE, '..', '..', '..', 'client', 'src')

// Fichiers qui lisent le cache client — le seul code qu'une colonne absente du
// snapshot peut casser.
function fichiersDuCache(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(js|jsx)$/.test(e.name)) continue
      const src = readFileSync(p, 'utf8')
      if (/useTable\(|getRecord\(|isTableHydrated\(|from '[./]*(?:lib\/)?dataStore\.js'/.test(src)) out.push([p, src])
    }
  }
  walk(dir)
  return out
}

// Tous les identifiants qui apparaissent dans ces fichiers. Les noms de colonnes
// n'utilisent que [a-z0-9_] : un identifiant présent = colonne potentiellement lue.
// Volontairement large — un faux positif garde une colonne de trop dans le
// snapshot, un faux négatif casserait une page.
function identifiantsDuCache(dir) {
  const found = new Set()
  for (const [, src] of fichiersDuCache(dir)) {
    for (const m of src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) found.add(m)
  }
  return found
}

test('aucune colonne exclue du snapshot n\'est lue par une page du cache', (t) => {
  if (!existsSync(DB_PATH) || !existsSync(CLIENT_SRC)) {
    t.skip('base ou client absents (environnement sans données)')
    return
  }
  const db = new Database(DB_PATH, { readonly: true })
  let supprimes
  try {
    supprimes = db.prepare(`
      SELECT erp_table, column_name FROM custom_fields WHERE deleted_at IS NOT NULL
      UNION SELECT erp_table, column_name FROM purged_fields
    `).all()
  } finally { db.close() }

  const identifiants = identifiantsDuCache(CLIENT_SRC)
  const fautifs = supprimes
    .filter(r => !isSnapshotKept(r.erp_table, r.column_name))
    .filter(r => identifiants.has(r.column_name))
    .filter(r => !SNAPSHOT_REVIEWED[r.erp_table]?.includes(r.column_name))
    .map(r => `${r.erp_table}.${r.column_name}`)

  assert.deepEqual(fautifs, [],
    `Ces colonnes sortent du snapshot alors qu'une page du cache les nomme encore.\n` +
    `Vérifie chaque cas : si la page lit vraiment la colonne sur un record de cette\n` +
    `table, ajoute-la à SNAPSHOT_KEEP ; si c'est une collision de nom, à\n` +
    `SNAPSHOT_REVIEWED (db/snapshotFields.js) :\n  ` +
    fautifs.join('\n  '))
})
