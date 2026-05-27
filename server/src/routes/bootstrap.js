// Bootstrap endpoints — fournissent au client un snapshot complet de l'état
// opérationnel (tables cachées) et un delta incrémental depuis un timestamp.
//
//   GET /api/bootstrap
//     → { snapshot_ts, tables: { <table>: { columns: [...], rows: [[...], …] } } }
//
//   GET /api/bootstrap/delta?since=<iso>
//     → { snapshot_ts, since, tables: { <table>: { columns, upsert: [[...]], delete: [ids…] } } }
//     → 410 Gone si `since` est plus vieux que la rétention de change_log (48h)
//       — le client doit alors refaire un /api/bootstrap complet.
//
// Format colonne-orienté : les noms de colonnes ne sont écrits qu'une fois par
// table, les rows sont des tuples positionnels. Gain massif vs format JSON
// classique (clé répétée à chaque row) — surtout sur les tables larges
// (contacts 112 cols, products 176 cols, tickets 60 cols, …). Le client
// reconstruit les objets via columns.map((c,i) => row[i]).
//
// La liste des tables cachées + la config des champs exclus est centralisée
// dans server/src/db/changeLog.js (CACHED_TABLES).

import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { CACHED_TABLES, getAllCachedTableSpecs } from '../db/changeLog.js'

const router = Router()

// Rétention de change_log : aligné avec la purge dans initChangeLog.
const CHANGE_LOG_RETENTION_HOURS = 48

// Convertit un array de rows objets (better-sqlite3) en format colonne-orienté.
// rows: array d'objets {col: val} → { columns: [...], rows: [[v1, v2, …]] }
function toColumnar(rowsObj, columns) {
  const rows = new Array(rowsObj.length)
  for (let i = 0; i < rowsObj.length; i++) {
    const r = rowsObj[i]
    const tuple = new Array(columns.length)
    for (let j = 0; j < columns.length; j++) tuple[j] = r[columns[j]]
    rows[i] = tuple
  }
  return { columns, rows }
}

// Snapshot complet — toutes les tables cachées en un seul payload.
router.get('/', requireAuth, (req, res) => {
  const specs = getAllCachedTableSpecs()
  const tables = {}
  const snapshotTs = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS ts`).get().ts

  for (const tableName of Object.keys(specs)) {
    const spec = specs[tableName]
    try {
      const rowsObj = db.prepare(`SELECT ${spec.selectClause} FROM ${tableName}`).all()
      tables[tableName] = toColumnar(rowsObj, spec.columns)
    } catch (err) {
      console.error(`[bootstrap] failed to load ${tableName}:`, err.message)
      tables[tableName] = { columns: spec.columns, rows: [] }
    }
  }

  res.json({ snapshot_ts: snapshotTs, tables })
})

// Delta depuis un timestamp donné. Le client envoie son `since` (le snapshot_ts
// de sa dernière synchro) et reçoit la liste des records modifiés/supprimés.
router.get('/delta', requireAuth, (req, res) => {
  const since = req.query.since
  if (!since || typeof since !== 'string') {
    return res.status(400).json({ error: 'since query param required (ISO timestamp)' })
  }

  // Si le `since` est plus vieux que la rétention du change_log, on ne peut
  // pas garantir un delta correct (des entries ont été purgées). Le client doit
  // refaire un full bootstrap.
  const retentionCutoff = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS cutoff
  `).get(`-${CHANGE_LOG_RETENTION_HOURS} hours`).cutoff

  if (since < retentionCutoff) {
    return res.status(410).json({
      error: 'since is older than change_log retention; re-bootstrap required',
      retention_hours: CHANGE_LOG_RETENTION_HOURS,
    })
  }

  const snapshotTs = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS ts`).get().ts
  const specs = getAllCachedTableSpecs()
  const tables = {}

  // Pour chaque (table, record_id) modifié depuis `since`, on prend l'entry la
  // plus récente — si c'est un delete, on émet un tombstone ; sinon on relit
  // la row complète depuis la table.
  const changes = db.prepare(`
    SELECT table_name, record_id, change_type, changed_at
    FROM change_log
    WHERE changed_at > ?
      AND id IN (
        SELECT MAX(id) FROM change_log
        WHERE changed_at > ?
        GROUP BY table_name, record_id
      )
    ORDER BY changed_at ASC
  `).all(since, since)

  // Regroupe par table
  const byTable = new Map()
  for (const c of changes) {
    if (!specs[c.table_name]) continue // table pas dans la liste cachée — ignore
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, { upsertIds: [], deleteIds: [] })
    const bucket = byTable.get(c.table_name)
    if (c.change_type === 'delete') bucket.deleteIds.push(c.record_id)
    else bucket.upsertIds.push(c.record_id)
  }

  for (const [tableName, { upsertIds, deleteIds }] of byTable.entries()) {
    const spec = specs[tableName]
    let upsertRowsObj = []
    if (upsertIds.length > 0) {
      // Re-lit les rows actuelles (au cas où il y aurait eu plusieurs mutations
      // entre `since` et maintenant — on ne renvoie que l'état final).
      const placeholders = upsertIds.map(() => '?').join(',')
      try {
        upsertRowsObj = db.prepare(`
          SELECT ${spec.selectClause}
          FROM ${tableName}
          WHERE ${spec.idColumn} IN (${placeholders})
        `).all(...upsertIds)
      } catch (err) {
        console.error(`[bootstrap/delta] failed to load ${tableName} upserts:`, err.message)
      }
    }
    const { columns, rows } = toColumnar(upsertRowsObj, spec.columns)
    tables[tableName] = { columns, upsert: rows, delete: deleteIds }
  }

  res.json({ snapshot_ts: snapshotTs, since, tables })
})

// Endpoint de debug : liste les tables cachées et leur cardinalité actuelle.
router.get('/info', requireAuth, (req, res) => {
  const specs = getAllCachedTableSpecs()
  const tables = {}
  for (const name of Object.keys(specs)) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get()
    tables[name] = { rows: c.c, columns: specs[name].columns.length, excluded: CACHED_TABLES.find(t => t.name === name)?.exclude || [] }
  }
  res.json({ tables, retention_hours: CHANGE_LOG_RETENTION_HOURS })
})

export default router
