// Historique des révisions d'une fiche : « qui a changé quel champ, de quoi à
// quoi, quand » — le panneau « Historique » au bas de chaque fiche.
//
// Pourquoi un instantané + diff plutôt que des triggers par colonne : SQLite
// refuse un DROP COLUMN tant qu'un trigger nomme la colonne, et l'app en droppe
// partout (migrations, purge de champs, re-typage). On ne pose donc AUCUN
// trigger de plus : change_log (db/changeLog.js) dit déjà quel record a bougé,
// toutes origines confondues. Ce watcher relit le record, le compare à son
// dernier instantané (record_snapshots) et inscrit les champs qui diffèrent
// dans record_revisions. Une réécriture à l'identique (sync Airtable) ne
// produit rien.
//
// Auteur : activity_log (l'action attribuée de la route) à ±5 s ; sinon
// l'écriture vient d'une sync ou d'une automation → « Système ».

import db from '../db/database.js'
import { resolveRecordKeys } from './recordLinks.js'

// Tables qui ont une fiche. `exclude` : colonnes lourdes ou techniques.
export const REVISION_TABLES = {
  companies: {}, contacts: {}, projects: {}, orders: {}, factures: {},
  tickets: {}, tasks: {}, shipments: {}, adresses: {}, employees: {},
  paies: {}, serial_numbers: {}, returns: {}, purchases: {},
  soumissions: {}, fournitures: {}, ops_issues: {},
  products: { exclude: ['tech_info_fields'] },
  sale_receipts: { exclude: ['raw_data'] },
  marketing_forms: { exclude: ['fields_json'] },
}

// Entité activity_log de chaque table (attribution de l'auteur).
const ENTITY = {
  companies: 'company', contacts: 'contact', projects: 'project', orders: 'order',
  factures: 'facture', tickets: 'ticket', tasks: 'task', shipments: 'shipment',
  adresses: 'adresse', employees: 'employee', paies: 'paie', serial_numbers: 'serial',
  returns: 'return', purchases: 'purchase', soumissions: 'soumission',
  fournitures: 'fourniture', ops_issues: 'ops_issue', products: 'product',
  sale_receipts: 'sale_receipt', marketing_forms: 'marketing_form',
}

// Colonnes de mécanique (horodatages de sync, de vérification…) : jamais une
// révision à elles seules.
const NOISE = /^(id|created_at|updated_at|synced_at|geocoded_at|password_hash|last_hubspot_sync|hs_updated_at|hs_created_at|airtable_modified_at)$|_checked_at$|_synced_at$|^last_sync/

const MAX_VALUE = 20000
const POLL_MS = 3000
const BATCH = 1000
const ATTRIB_MS = 5000

// Tables : db/schema.js (record_snapshots, record_revisions, record_revision_state).
const getState = k => db.prepare('SELECT value FROM record_revision_state WHERE key = ?').get(k)?.value ?? null
const setState = (k, v) => db.prepare('INSERT OR REPLACE INTO record_revision_state (key, value) VALUES (?, ?)').run(k, String(v))

// Colonnes suivies : physiques (hors générées), hors bruit, hors champs supprimés.
const colsCache = new Map()
function trackedColumns(table) {
  const hit = colsCache.get(table)
  if (hit && Date.now() - hit.at < 60_000) return hit.cols
  const exclude = new Set(REVISION_TABLES[table]?.exclude || [])
  const dead = new Set([
    ...db.prepare('SELECT column_name FROM custom_fields WHERE erp_table = ? AND deleted_at IS NOT NULL').all(table).map(r => r.column_name),
    ...db.prepare('SELECT column_name FROM purged_fields WHERE erp_table = ?').all(table).map(r => r.column_name),
  ])
  const cols = db.pragma(`table_xinfo(${table})`)
    .filter(c => !c.hidden && !/BLOB/i.test(c.type || '') && !NOISE.test(c.name) && !exclude.has(c.name) && !dead.has(c.name))
    .map(c => c.name)
  colsCache.set(table, { at: Date.now(), cols })
  return cols
}

// Instantané compact : seules les valeurs non vides (clé absente = vide).
function snapshotOf(table, row) {
  const out = {}
  for (const c of trackedColumns(table)) {
    let v = row[c]
    if (v == null || v === '' || Buffer.isBuffer(v)) continue
    if (typeof v === 'string' && v.length > MAX_VALUE) v = v.slice(0, MAX_VALUE)
    out[c] = v
  }
  return out
}

// Liste d'identifiants d'un champ lien, quelle que soit sa forme stockée : la
// sync Airtable écrit tantôt « recA, recB », tantôt '["recA","recB"]'. Sans
// cette lecture, un simple changement de format passait pour une révision.
const REC_LIST = /^rec[A-Za-z0-9]{14}(\s*,\s*rec[A-Za-z0-9]{14})*$/
export function keyList(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t)
      if (Array.isArray(a) && a.every(x => typeof x === 'string')) return a
    } catch { /* pas du JSON */ }
    return null
  }
  return REC_LIST.test(t) ? t.split(/\s*,\s*/) : null
}

const canon = v => {
  const l = keyList(v)
  return l ? [...l].sort().join(',') : String(v ?? '')
}
const same = (o, n) => canon(o) === canon(n)

function diff(before, after) {
  const changes = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const o = before[k] ?? null, n = after[k] ?? null
    if (same(o, n)) continue
    changes.push({ c: k, o, n })
  }
  return changes
}

// Rejoue la règle d'égalité sur les révisions déjà inscrites (une fois par
// version de la règle) : retire les champs qui n'avaient changé que de forme.
function pruneNoise(version) {
  if (getState(`prune:${version}`)) return
  const rows = db.prepare(`SELECT id, changes FROM record_revisions WHERE kind = 'updated'`).all()
  let dropped = 0
  db.transaction(() => {
    for (const r of rows) {
      const all = JSON.parse(r.changes || '[]')
      const kept = all.filter(ch => !same(ch.o, ch.n))
      if (kept.length === all.length) continue
      if (!kept.length) { db.prepare('DELETE FROM record_revisions WHERE id = ?').run(r.id); dropped++ }
      else db.prepare('UPDATE record_revisions SET changes = ? WHERE id = ?').run(JSON.stringify(kept), r.id)
    }
    setState(`prune:${version}`, new Date().toISOString())
  })()
  if (dropped) console.log(`[revisions] ${dropped} révisions de pure forme retirées`)
}

function actorFor(table, id, at) {
  const entity = ENTITY[table]
  if (!entity) return null
  const t = Date.parse(at)
  if (Number.isNaN(t)) return null
  const row = db.prepare(`
    SELECT user_id FROM activity_log
    WHERE entity_type = ? AND entity_id = ? AND user_id IS NOT NULL
      AND created_at BETWEEN ? AND ?
    ORDER BY ABS(julianday(created_at) - julianday(?)) LIMIT 1
  `).get(entity, String(id), new Date(t - ATTRIB_MS).toISOString(), new Date(t + ATTRIB_MS).toISOString(), at)
  return row?.user_id || null
}

// Traite un record qui a bougé. Exporté pour les tests.
export function processRecord(table, id, changeType, at) {
  const prev = db.prepare('SELECT data FROM record_snapshots WHERE table_name = ? AND record_id = ?').get(table, String(id))
  const before = prev ? JSON.parse(prev.data) : null
  const row = changeType === 'delete' ? null : db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  const insertRev = db.prepare(`INSERT INTO record_revisions (table_name, record_id, kind, changes, user_id, changed_at) VALUES (?, ?, ?, ?, ?, ?)`)

  if (!row) {
    if (before) {
      insertRev.run(table, String(id), 'deleted', null, actorFor(table, id, at), at)
      db.prepare('DELETE FROM record_snapshots WHERE table_name = ? AND record_id = ?').run(table, String(id))
    }
    return
  }
  const after = snapshotOf(table, row)
  if (!before) {
    insertRev.run(table, String(id), 'created', null, actorFor(table, id, at), at)
  } else {
    const changes = diff(before, after)
    if (!changes.length) return
    insertRev.run(table, String(id), 'updated', JSON.stringify(changes), actorFor(table, id, at), at)
  }
  db.prepare('INSERT OR REPLACE INTO record_snapshots (table_name, record_id, data) VALUES (?, ?, ?)')
    .run(table, String(id), JSON.stringify(after))
}

const TABLE_LIST = () => Object.keys(REVISION_TABLES)

function pollOnce() {
  const tables = TABLE_LIST()
  const cursor = Number(getState('cursor') || 0)
  const rows = db.prepare(`
    SELECT id, table_name, record_id, change_type, changed_at FROM change_log
    WHERE id > ? AND table_name IN (${tables.map(() => '?').join(',')})
    ORDER BY id ASC LIMIT ?
  `).all(cursor, ...tables, BATCH)
  if (!rows.length) return 0
  // Dernière mutation par record dans le lot : un seul diff, à l'heure de la dernière.
  const last = new Map()
  for (const r of rows) last.set(`${r.table_name}\u0000${r.record_id}`, r)
  db.transaction(() => {
    for (const r of last.values()) {
      try { processRecord(r.table_name, r.record_id, r.change_type, r.changed_at) }
      catch (e) { console.error('[revisions]', r.table_name, r.record_id, e.message) }
    }
    setState('cursor', rows[rows.length - 1].id)
  })()
  return rows.length
}

// Premier passage par table : instantané de tous les records existants, sans
// révision (on ne connaît pas leur passé). Par paquets, pour ne pas figer
// l'event loop au démarrage.
async function bootstrapTable(table) {
  if (getState(`boot:${table}`)) return
  const ins = db.prepare('INSERT OR IGNORE INTO record_snapshots (table_name, record_id, data) VALUES (?, ?, ?)')
  let offset = 0
  for (;;) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1000 OFFSET ?`).all(offset)
    if (!rows.length) break
    db.transaction(() => { for (const r of rows) ins.run(table, String(r.id), JSON.stringify(snapshotOf(table, r))) })()
    offset += rows.length
    await new Promise(r => setImmediate(r))
  }
  setState(`boot:${table}`, new Date().toISOString())
  console.log(`[revisions] instantané initial ${table} : ${offset} records`)
}

let timer = null
export async function startRecordRevisions() {
  // Curseur posé AVANT l'instantané initial : ce qui bouge pendant qu'on le
  // prend sera diffé ensuite.
  if (getState('cursor') == null) setState('cursor', db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m || 0)
  try { pruneNoise('v1') } catch (e) { console.error('[revisions] nettoyage', e.message) }
  for (const t of TABLE_LIST()) {
    try { await bootstrapTable(t) } catch (e) { console.error('[revisions] instantané', t, e.message) }
  }
  timer = setInterval(() => {
    try { pollOnce() } catch (e) { console.error('[revisions] poll', e.message) }
  }, POLL_MS)
  timer.unref?.()
  console.log('[revisions] started')
}

// Lecture pour le panneau : révisions + libellé/type des champs + noms des
// records liés.
export function listRevisions(table, id, { limit = 300 } = {}) {
  const revs = db.prepare(`
    SELECT r.id, r.kind, r.changes, r.changed_at, r.user_id, u.name AS user_name
    FROM record_revisions r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.table_name = ? AND r.record_id = ?
    ORDER BY r.id DESC LIMIT ?
  `).all(table, String(id), limit).reverse()

  const fields = {}
  for (const f of db.prepare(`SELECT column_name, name, type, options FROM custom_fields WHERE erp_table = ? AND deleted_at IS NULL`).all(table)) {
    let options = null
    try { options = JSON.parse(f.options || 'null') } catch { /* options illisibles */ }
    fields[f.column_name] = { label: f.name, type: f.type, choices: Array.isArray(options?.choices) ? options.choices : undefined }
  }

  const parsed = revs.map(r => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] }))
  // Champs lien Airtable : les record IDs deviennent des noms, en un seul appel.
  const keys = parsed.flatMap(r => r.changes.flatMap(ch => [...(keyList(ch.o) || []), ...(keyList(ch.n) || [])]))
  const resolved = keys.length ? resolveRecordKeys(keys) : {}
  const names = v => {
    const l = keyList(v)
    return l ? l.map(k => resolved[k]?.label || k).join(', ') : undefined
  }
  const data = parsed.map(r => ({
    id: r.id, kind: r.kind, changed_at: r.changed_at, user_name: r.user_name || null,
    changes: r.changes.map(ch => {
      const lists = keyList(ch.o) || keyList(ch.n)
      return {
        column: ch.c, old: ch.o, new: ch.n,
        ...(lists ? { old_label: names(ch.o) ?? null, new_label: names(ch.n) ?? null } : linkLabels(table, ch)),
      }
    }),
  }))
  let created_at = null
  try { created_at = db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).get(id)?.created_at || null } catch { /* sans created_at */ }
  return { data, fields, created_at }
}

// FK `<table>_id` : nom lisible des deux côtés.
const LABEL_COLS = ['name', 'document_number', 'title', 'order_number', 'serial', 'email']
function linkLabels(table, ch) {
  if (!ch.c.endsWith('_id')) return {}
  const base = ch.c.slice(0, -3)
  const target = [base + 's', base + 'es', base].find(t => /^[a-z_]+$/.test(t) && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t))
  if (!target) return {}
  const cols = db.pragma(`table_info(${target})`).map(c => c.name)
  const expr = cols.includes('first_name') && cols.includes('last_name')
    ? `TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))`
    : LABEL_COLS.find(c => cols.includes(c))
  if (!expr) return {}
  const label = v => (v == null ? null : db.prepare(`SELECT ${expr} AS l FROM ${target} WHERE id = ?`).get(v)?.l ?? null)
  return { old_label: label(ch.o), new_label: label(ch.n), link_table: target }
}
