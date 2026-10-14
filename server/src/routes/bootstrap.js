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
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import db, { openReaderConnection } from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { CACHED_TABLES, getAllCachedTableSpecs, CHANGE_LOG_RETENTION_HOURS, rollupParentsChangedSince } from '../db/changeLog.js'

import { filterCachedSpecs } from '../services/dataAccess.js'
import { ensureUploadsDir } from '../config/uploads.js'

const router = Router()

// Rétention de change_log : la valeur vient de changeLog.js, qui porte aussi la
// purge — deux constantes séparées auraient fini par diverger.

// Au-delà de ce nombre de records modifiés, un delta n'a plus d'intérêt : il
// pèserait autant qu'un snapshot complet mais serait construit d'un bloc, sans
// le streaming du bootstrap. On renvoie 410 et le client re-bootstrape.
const MAX_DELTA_RECORDS = 20_000

// Empreinte de la FORME du snapshot (tables + colonnes envoyées, et DÉFINITION
// des champs calculés). Le client la mémorise et refait un bootstrap complet dès
// qu'elle change : sinon, un champ custom ajouté (nouvelle colonne de la vue
// <table>_v) n'apparaîtrait que sur les records touchés par un delta, les autres
// restant vides indéfiniment.
//
// `computedSignature` couvre le cas où le NOM des colonnes ne bouge pas mais où
// leurs valeurs changent pour toutes les lignes d'un coup : convertir un champ
// de donnée en rollup, corriger une formule, repointer un lookup. Aucun record
// n'est touché, donc le delta est vide — sans cette empreinte, le cache du
// navigateur gardait les anciennes valeurs (typiquement vides) indéfiniment.
function columnsSignature(specs) {
  const parts = Object.keys(specs).sort()
    .map(t => `${t}:${specs[t].columns.join(',')}#${specs[t].computedSignature || ''}`)
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

// Cache du snapshot — chaque redémarrage du serveur ou nouvelle version du
// client faisait recharger les ~7 Mo à plusieurs onglets à la fois : 2-3 s de
// calcul chacun, et l'API ralentie pour tout le monde. Le snapshot est le même
// pour tous les utilisateurs qui voient les mêmes tables (la clé = l'empreinte
// des colonnes, qui inclut la liste des tables) ; un snapshot de quelques
// minutes reste exact, le client rattrape la suite par delta depuis son
// snapshot_ts. Gardé aussi sur disque : il survit au redémarrage, qui est
// justement le moment où les onglets rechargent.
const SNAPSHOT_TTL_MS = 10 * 60_000
const cacheDir = ensureUploadsDir('cache')
const snapshotCache = new Map() // clé → { at, body: Buffer }
const snapshotBuilds = new Map() // clé → Promise<Buffer|null>

function cachedSnapshot(key) {
  const hit = snapshotCache.get(key)
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.body
  const file = path.join(cacheDir, `bootstrap-${key}.json`)
  try {
    const at = fs.statSync(file).mtimeMs
    if (Date.now() - at >= SNAPSHOT_TTL_MS) return null
    const body = fs.readFileSync(file)
    snapshotCache.set(key, { at, body })
    return body
  } catch { return null }
}

function storeSnapshot(key, body) {
  snapshotCache.set(key, { at: Date.now(), body })
  const file = path.join(cacheDir, `bootstrap-${key}.json`)
  fs.promises.writeFile(`${file}.tmp`, body)
    .then(() => fs.promises.rename(`${file}.tmp`, file))
    .catch(e => console.warn('[bootstrap] cache disque:', e.message))
}

async function sendBody(res, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', body.length)
  res.end(body)
}

router.get('/', requireAuth, async (req, res) => {
  const specs = filterCachedSpecs(getAllCachedTableSpecs(), req.user)
  const signature = columnsSignature(specs)

  const cached = cachedSnapshot(signature)
  if (cached) return sendBody(res, cached)
  // Un autre onglet construit déjà ce snapshot : on attend le sien.
  if (snapshotBuilds.has(signature)) {
    const body = await snapshotBuilds.get(signature).catch(() => null)
    if (body) return sendBody(res, body)
  }

  let settle
  snapshotBuilds.set(signature, new Promise(r => { settle = r }))
  const parts = []
  const emit = (chunk) => { parts.push(chunk); return writeChunk(res, chunk) }

  const snapshotTs = db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS ts`).get().ts

  // Connexion dédiée : l'itérateur reste ouvert pendant les `await` de
  // contre-pression, ce qui rend sa connexion « busy ». Sur la connexion
  // principale, cela faisait échouer toutes les écritures concurrentes
  // (« This database connection is busy executing a query »).
  const reader = openReaderConnection()

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  let complete = false
  let tableFailed = false
  try {
    await emit(`{"snapshot_ts":${JSON.stringify(snapshotTs)}` +
      `,"columns_signature":${JSON.stringify(signature)},"tables":{`)

    let firstTable = true
    for (const tableName of Object.keys(specs)) {
      const spec = specs[tableName]
      const columns = spec.columns
      await emit(`${firstTable ? '' : ','}${JSON.stringify(tableName)}` +
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
            await emit(buffer)
            buffer = ''
          }
        }
      } catch (err) {
        // Table illisible : on ferme proprement le tableau de lignes déjà émises
        // plutôt que de casser tout le snapshot pour les autres tables.
        // Un tel snapshot n'est pas mis en cache.
        if (err.message === 'client déconnecté') throw err
        tableFailed = true
        console.error(`[bootstrap] failed to load ${tableName}:`, err.message)
      }
      if (buffer) await emit(buffer)
      await emit(']}')
    }
    parts.push('}}')
    res.end('}}')
    complete = true
  } catch (err) {
    // Client parti en cours de route (onglet fermé, rechargement) : rien à dire.
    // Toute autre panne au milieu du flux ne peut plus devenir un code d'erreur —
    // les entêtes sont déjà partis —, on coupe pour que le client refasse un appel.
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.destroy()
  } finally {
    try { reader.close() } catch { /* connexion déjà fermée */ }
    const body = complete && !tableFailed ? Buffer.from(parts.join('')) : null
    if (body) storeSnapshot(signature, body)
    snapshotBuilds.delete(signature)
    settle(body)
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
  const specs = filterCachedSpecs(getAllCachedTableSpecs(), req.user)
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
  // Parents dont un rollup a bougé (ligne enfant modifiée) : à relire comme un
  // upsert, sauf s'ils ont eux-mêmes été supprimés dans la tranche.
  for (const p of rollupParentsChangedSince(since)) {
    const key = `${p.table_name} ${p.record_id}`
    if (!lastByKey.has(key)) lastByKey.set(key, { ...p, change_type: 'upsert' })
  }

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
  const specs = filterCachedSpecs(getAllCachedTableSpecs(), req.user)
  const tables = {}
  for (const name of Object.keys(specs)) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get()
    tables[name] = { rows: c.c, columns: specs[name].columns.length, excluded: CACHED_TABLES.find(t => t.name === name)?.exclude || [] }
  }
  res.json({ tables, retention_hours: CHANGE_LOG_RETENTION_HOURS })
})

export default router
