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

import { createHash } from 'node:crypto'
import { Router } from 'express'
import db, { openReaderConnection } from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { CACHED_TABLES, getAllCachedTableSpecs, CHANGE_LOG_RETENTION_HOURS } from '../db/changeLog.js'

const router = Router()

// Rétention de change_log : la valeur vient de changeLog.js, qui porte aussi la
// purge — deux constantes séparées auraient fini par diverger.

// Au-delà de ce nombre de records modifiés, un delta n'a plus d'intérêt : il
// pèserait autant qu'un snapshot complet mais serait construit d'un bloc, sans
// le streaming du bootstrap. On renvoie 410 et le client re-bootstrape.
const MAX_DELTA_RECORDS = 20_000

// Empreinte de la FORME du snapshot (tables + colonnes envoyées). Le client la
// mémorise et refait un bootstrap complet dès qu'elle change : sinon, un champ
// custom ajouté (nouvelle colonne de la vue <table>_v) n'apparaîtrait que sur
// les records touchés par un delta, les autres restant vides indéfiniment.
function columnsSignature(specs) {
  const parts = Object.keys(specs).sort()
    .map(t => `${t}:${specs[t].columns.join(',')}`)
    .join(';')
  return createHash('sha1').update(parts).digest('hex').slice(0, 16)
}

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

// Écrit un morceau en respectant la contre-pression, et rend la main à la boucle
// d'événements entre deux tables. Sans ça, construire les ~30 Mo du snapshot
// bloquait le thread 3,5 s : pendant ce temps l'API ne répondait à personne
// d'autre et node-cron ratait ses exécutions.
function writeChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('client déconnecté'))
    if (res.write(chunk)) return setImmediate(resolve)
    res.once('drain', resolve)
  })
}

// Snapshot complet — envoyé en flux, par paquets de lignes.
//
// Avant : tout le payload était construit en mémoire puis sérialisé d'un bloc.
// Node étant mono-thread, l'API ne répondait à personne pendant ~3,5 s (node-cron
// ratait ses exécutions). Maintenant on lit ligne à ligne (`iterate`) et on rend
// la main toutes les ROWS_PER_CHUNK lignes : le plus long blocage tombe sous les
// ~100 ms, et la mémoire ne monte plus au niveau du payload entier.
const ROWS_PER_CHUNK = 500

router.get('/', requireAuth, async (req, res) => {
  const specs = getAllCachedTableSpecs()
  const snapshotTs = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS ts`).get().ts

  // Connexion dédiée : l'itérateur reste ouvert pendant les `await` de
  // contre-pression, ce qui rend sa connexion « busy ». Sur la connexion
  // principale, cela faisait échouer toutes les écritures concurrentes
  // (« This database connection is busy executing a query »).
  const reader = openReaderConnection()

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  try {
    await writeChunk(res, `{"snapshot_ts":${JSON.stringify(snapshotTs)}` +
      `,"columns_signature":${JSON.stringify(columnsSignature(specs))},"tables":{`)

    let firstTable = true
    for (const tableName of Object.keys(specs)) {
      const spec = specs[tableName]
      const columns = spec.columns
      await writeChunk(res, `${firstTable ? '' : ','}${JSON.stringify(tableName)}` +
        `:{"columns":${JSON.stringify(columns)},"rows":[`)
      firstTable = false

      let count = 0
      let buffer = ''
      try {
        // Tables à soft-delete : ne jamais envoyer les records supprimés au cache.
        const where = spec.hasSoftDelete ? ' WHERE deleted_at IS NULL' : ''
        // spec.relation = la VUE <table>_v si elle existe → les champs custom
        // calculés (formule / lookup / rollup) partent avec le snapshot.
        const stmt = reader.prepare(`SELECT ${spec.selectClause} FROM ${spec.relation}${where}`)
        for (const row of stmt.iterate()) {
          const tuple = new Array(columns.length)
          for (let j = 0; j < columns.length; j++) tuple[j] = row[columns[j]]
          buffer += (count ? ',' : '') + JSON.stringify(tuple)
          count++
          if (count % ROWS_PER_CHUNK === 0) {
            await writeChunk(res, buffer)
            buffer = ''
          }
        }
      } catch (err) {
        // Table illisible : on ferme proprement le tableau de lignes déjà émises
        // plutôt que de casser tout le snapshot pour les autres tables.
        console.error(`[bootstrap] failed to load ${tableName}:`, err.message)
      }
      if (buffer) await writeChunk(res, buffer)
      await writeChunk(res, ']}')
    }

    res.end('}}')
  } catch (err) {
    // Client parti en cours de route (onglet fermé, rechargement) : rien à dire.
    // Toute autre panne au milieu du flux ne peut plus devenir un code d'erreur —
    // les entêtes sont déjà partis —, on coupe pour que le client refasse un appel.
    if (!res.headersSent) return res.status(500).json({ error: err.message })
    res.destroy()
  } finally {
    try { reader.close() } catch { /* connexion déjà fermée */ }
  }
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

  // Lecture de la tranche `changed_at > since`, en index-only et déjà ordonnée
  // par (changed_at, id) grâce à idx_change_log_delta (migration 021).
  //
  // Le « dernière entrée par (table, record) » se faisait avant en SQL, avec un
  // `GROUP BY table_name, record_id` — et c'est ce GROUP BY qui faisait choisir à
  // SQLite un balayage complet des 166 620 lignes de change_log plutôt que la
  // tranche demandée : 118 ms par appel, à chaque poll de chaque onglet, pendant
  // lesquelles la boucle d'événements ne répondait à personne. Fait en JS sur
  // quelques dizaines de lignes, c'est gratuit : 0,04 ms mesuré.
  const slice = db.prepare(`
    SELECT id, table_name, record_id, change_type
    FROM change_log
    WHERE changed_at > ?
    ORDER BY changed_at ASC, id ASC
  `).all(since)

  // Tranche ordonnée : la dernière écriture pour une clé écrase les précédentes.
  const lastByKey = new Map()
  for (const c of slice) lastByKey.set(`${c.table_name} ${c.record_id}`, c)

  // Delta démesuré (onglet en veille depuis des heures, ou grosse resynchro
  // Airtable) : le renvoyer coûterait plus cher qu'un snapshot complet, et sans
  // le streaming ni la contre-pression de celui-ci. On répond 410 comme pour un
  // `since` hors rétention — le client sait déjà refaire un bootstrap.
  if (lastByKey.size > MAX_DELTA_RECORDS) {
    return res.status(410).json({
      error: 'delta too large; re-bootstrap required',
      changed_records: lastByKey.size,
      max_delta_records: MAX_DELTA_RECORDS,
    })
  }

  // Regroupe par table
  const byTable = new Map()
  for (const c of lastByKey.values()) {
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
      // Tables à soft-delete : on ne relit que les records vivants ; ceux qui
      // ont été supprimés (deleted_at posé) sont émis comme tombstones plus bas.
      const placeholders = upsertIds.map(() => '?').join(',')
      const softWhere = spec.hasSoftDelete ? ' AND deleted_at IS NULL' : ''
      try {
        upsertRowsObj = db.prepare(`
          SELECT ${spec.selectClause}
          FROM ${spec.relation}
          WHERE ${spec.idColumn} IN (${placeholders})${softWhere}
        `).all(...upsertIds)
      } catch (err) {
        console.error(`[bootstrap/delta] failed to load ${tableName} upserts:`, err.message)
      }
    }
    // Soft-delete : tout upsertId qui n'est pas revenu vivant a été supprimé →
    // tombstone pour que le client le retire de son cache.
    if (spec.hasSoftDelete && upsertIds.length > 0) {
      const liveIds = new Set(upsertRowsObj.map(r => r[spec.idColumn]))
      for (const uid of upsertIds) {
        if (!liveIds.has(uid)) deleteIds.push(uid)
      }
    }
    const { columns, rows } = toColumnar(upsertRowsObj, spec.columns)
    tables[tableName] = { columns, upsert: rows, delete: deleteIds }
  }

  res.json({ snapshot_ts: snapshotTs, since, columns_signature: columnsSignature(specs), tables })
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
