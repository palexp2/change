// Ctrl+Z dans toute l'app : annule la dernière modification faite par
// l'utilisateur, quelle que soit la page ou le composant qui l'a écrite.
//
// Source : l'historique des fiches (services/recordRevisions.js). Chaque
// révision porte « champ, ancienne → nouvelle valeur, auteur » ; annuler, c'est
// réécrire les anciennes valeurs. Garde-fous :
//   • seulement les révisions de l'utilisateur, de la dernière heure ;
//   • un champ modifié depuis (par quelqu'un d'autre, une sync…) n'est pas
//     écrasé — la révision n'annule que les champs encore dans leur état ;
//   • la réécriture produit elle-même une révision, marquée `undo_of` : elle
//     n'est jamais reprise par le Ctrl+Z suivant (sinon on oscillerait).
// Création annulée = suppression douce (tables à `deleted_at` seulement).

import db from '../db/database.js'
import { pollOnce, same, MAX_VALUE } from './recordRevisions.js'
import { emitMirrorWrite } from './realtimeEmitters.js'

const WINDOW = '-60 minutes'
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Traite tout ce qui attend dans change_log : une modification d'il y a moins
// de 3 s n'est pas encore une révision.
export function flushRevisions() {
  for (let i = 0; i < 20 && pollOnce() >= 1000; i++) { /* lot suivant */ }
}

function columnsOf(table) {
  return new Map(db.pragma(`table_xinfo(${table})`).filter(c => !c.hidden).map(c => [c.name, c]))
}

// Nom des champs personnalisés ; les champs natifs sont nommés par le client
// (tableDefs), comme dans le panneau Historique.
function customLabels(table, cols) {
  const out = {}
  for (const c of cols) {
    const name = db.prepare('SELECT name FROM custom_fields WHERE erp_table = ? AND column_name = ? AND deleted_at IS NULL').get(table, c)?.name
    if (name) out[c] = name
  }
  return out
}

const maxRevId = () => db.prepare('SELECT MAX(id) AS m FROM record_revisions').get()?.m || 0

// Exécute `write`, puis marque les révisions qu'il a produites sur ce record
// comme issues d'une annulation de `targetId`.
function asUndo(table, id, targetId, write) {
  flushRevisions()
  const before = maxRevId()
  write()
  flushRevisions()
  db.prepare('UPDATE record_revisions SET undo_of = ? WHERE id > ? AND table_name = ? AND record_id = ?')
    .run(targetId, before, table, String(id))
  db.prepare(`UPDATE record_revisions SET undone_at = ${NOW_SQL} WHERE id = ?`).run(targetId)
}

// Annule une révision. Renvoie { kind, columns, labels } ou null si plus rien n'est
// annulable (champs modifiés depuis, record disparu).
function revert(rev, userId) {
  const { table_name: table, record_id: id } = rev
  const cols = columnsOf(table)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  if (!row) return null

  if (rev.kind === 'created') {
    if (!cols.has('deleted_at') || row.deleted_at) return null
    asUndo(table, id, rev.id, () => db.prepare(`UPDATE ${table} SET deleted_at = ${NOW_SQL} WHERE id = ?`).run(id))
    emitMirrorWrite(table, 'updated', id, ['deleted_at'], null, userId)
    return { kind: 'created', columns: ['deleted_at'] }
  }

  const tooLong = v => typeof v === 'string' && v.length >= MAX_VALUE
  const changes = JSON.parse(rev.changes || '[]').filter(ch =>
    cols.has(ch.c) && !tooLong(ch.o) && !tooLong(ch.n) && same(row[ch.c], ch.n))
  if (!changes.length) return null

  const values = changes.map(ch => (ch.o == null && cols.get(ch.c).notnull ? '' : ch.o))
  const sets = changes.map(ch => `"${ch.c}" = ?`)
  if (cols.has('updated_at')) sets.push(`updated_at = ${NOW_SQL}`)
  asUndo(table, id, rev.id, () => db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id))
  const columns = changes.map(ch => ch.c)
  emitMirrorWrite(table, 'updated', id, columns, null, userId)

  const restored = changes.some(ch => ch.c === 'deleted_at' && ch.o == null)
  return { kind: restored ? 'restored' : 'updated', columns, labels: customLabels(table, columns) }
}

// Dernière modification annulable de l'utilisateur. `localAgeMs` : âge de la
// dernière action annulable connue du navigateur seul (toast « Annuler ») ;
// si elle est plus récente, c'est à elle de passer → { use: 'local' }.
export function undoLastEdit(userId, { localAgeMs = null } = {}) {
  flushRevisions()
  const candidates = db.prepare(`
    SELECT id, table_name, record_id, kind, changes,
           CAST((julianday('now') - julianday(changed_at)) * 86400000 AS INTEGER) AS age_ms
    FROM record_revisions
    WHERE user_id = ? AND undone_at IS NULL AND undo_of IS NULL
      AND kind IN ('updated', 'created')
      AND julianday(changed_at) >= julianday('now', '${WINDOW}')
    ORDER BY id DESC LIMIT 25
  `).all(userId)

  for (const rev of candidates) {
    if (localAgeMs != null && localAgeMs < rev.age_ms) return { use: 'local' }
    const done = db.transaction(() => revert(rev, userId))()
    if (done) return { undone: true, table: rev.table_name, record_id: rev.record_id, age_ms: rev.age_ms, ...done }
    // Plus rien d'annulable dans celle-ci : on la retire et on passe à la précédente.
    db.prepare(`UPDATE record_revisions SET undone_at = ${NOW_SQL} WHERE id = ?`).run(rev.id)
  }
  return localAgeMs != null ? { use: 'local' } : { undone: false }
}

// Restauration faite hors Ctrl+Z (bouton « Annuler » d'un toast de
// suppression) : la suppression d'origine est consommée et la restauration
// n'est pas elle-même annulable — sinon le Ctrl+Z suivant re-supprimerait.
export function asRestoreOfDelete(table, id, write) {
  flushRevisions()
  const target = db.prepare(`
    SELECT id, changes FROM record_revisions
    WHERE table_name = ? AND record_id = ? AND kind = 'updated' AND undone_at IS NULL AND undo_of IS NULL
    ORDER BY id DESC LIMIT 5
  `).all(table, String(id)).find(r => JSON.parse(r.changes || '[]').some(ch => ch.c === 'deleted_at' && ch.o == null && ch.n != null))
  if (!target) return write()
  let out
  asUndo(table, id, target.id, () => { out = write() })
  return out
}
