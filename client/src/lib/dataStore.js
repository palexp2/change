// Store mémoire normalisé pour les tables cachées (voir CACHED_TABLES côté
// serveur : companies, contacts, products, projects, orders, …).
//
// Le store est hydraté au login par GET /api/bootstrap, puis maintenu à jour
// par :
//   1. WebSocket : events `<entity>:<verb>` poussent les changements en direct.
//   2. Delta polling : GET /api/bootstrap/delta?since=<lastSyncTs> toutes les
//      N secondes pour rattraper les mutations faites par les syncs externes
//      (Airtable, QB, Stripe, Gmail) qui ne broadcastent pas toujours.
//   3. Au retour de veille / reconnexion WS : delta immédiat ; si gap > 48h
//      ou si le delta endpoint répond 410 → full re-bootstrap.
//
// Format wire (colonne-orienté) : { columns: [...], rows: [[...], …] }
// → hydraté en Map<id, object> en mémoire pour lookups O(1) par id.

import { useSyncExternalStore } from 'react'

// État interne — un store par table.
// Chaque store : { data: Map<id, record>, listeners: Set<fn>, version: number }
const stores = new Map()

// snapshot_ts du dernier sync réussi (utilisé pour le delta polling).
let lastSyncTs = null

function ensureStore(tableName) {
  let s = stores.get(tableName)
  if (!s) {
    s = { data: new Map(), listeners: new Set(), version: 0, snapshot: null }
    stores.set(tableName, s)
  }
  return s
}

function notify(tableName) {
  const s = ensureStore(tableName)
  s.version++
  s.snapshot = null // invalide le snapshot mémoïsé
  for (const fn of s.listeners) {
    try { fn() } catch (e) { console.error(`[dataStore] listener error on ${tableName}:`, e) }
  }
}

// Hydrate une table depuis un payload colonne-orienté.
// payload : { columns: [...], rows: [[...], …] }
export function hydrateTable(tableName, payload, { replace = true } = {}) {
  const s = ensureStore(tableName)
  if (replace) s.data.clear()

  const { columns, rows } = payload
  if (!columns || !rows) return
  // idColumn est typiquement 'id' (toutes les tables ERP). On localise l'index
  // une seule fois pour la perf.
  const idIdx = columns.indexOf('id')
  if (idIdx < 0) {
    console.warn(`[dataStore] table ${tableName} has no 'id' column — skipping`)
    return
  }

  for (let i = 0; i < rows.length; i++) {
    const tuple = rows[i]
    const obj = {}
    for (let j = 0; j < columns.length; j++) obj[columns[j]] = tuple[j]
    s.data.set(tuple[idIdx], obj)
  }
  notify(tableName)
}

// Applique un delta sur une table : upserts + deletes.
export function applyDelta(tableName, delta) {
  const s = ensureStore(tableName)
  const { columns, upsert, delete: deleteIds } = delta
  let mutated = false

  if (upsert && upsert.length > 0 && columns) {
    const idIdx = columns.indexOf('id')
    if (idIdx >= 0) {
      for (let i = 0; i < upsert.length; i++) {
        const tuple = upsert[i]
        const obj = {}
        for (let j = 0; j < columns.length; j++) obj[columns[j]] = tuple[j]
        s.data.set(tuple[idIdx], obj)
        mutated = true
      }
    }
  }

  if (deleteIds && deleteIds.length > 0) {
    for (const id of deleteIds) {
      if (s.data.delete(id)) mutated = true
    }
  }

  if (mutated) notify(tableName)
}

/**
 * Fusionne quelques colonnes dans un record DÉJÀ en cache (mise à jour poussée
 * en direct par le WebSocket — édition d'un collègue, écriture d'une API
 * externe comme le miroir Airtable). Rend la liste des colonnes réellement
 * changées, ou null si rien n'a bougé.
 *
 * Deux prudences, qui sont la raison d'être de cette fonction plutôt que d'un
 * `applyDelta` avec une ligne partielle :
 *  - un record ABSENT du cache n'est pas créé : la ligne serait incomplète
 *    (charge utile partielle), et le delta poll l'apportera entière ;
 *  - une clé ABSENTE du record n'est pas ajoutée : les charges utiles temps
 *    réel des routes portent des champs joints (`company_name`, `items_count`)
 *    qui ne sont pas des colonnes de la table — les injecter changerait la
 *    forme des lignes du cache jusqu'au prochain bootstrap.
 */
export function patchRecord(tableName, id, values) {
  if (!id || !values) return null
  const s = ensureStore(tableName)
  const cur = s.data.get(id)
  if (!cur) return null
  const changed = []
  for (const k of Object.keys(values)) {
    if (k === 'id' || !(k in cur)) continue
    if (cur[k] === values[k]) continue
    changed.push(k)
  }
  if (!changed.length) return null
  const next = { ...cur }
  for (const k of changed) next[k] = values[k]
  s.data.set(id, next)
  notify(tableName)
  return changed
}

/**
 * Ajoute au cache un record créé ailleurs (miroir Airtable, autre onglet), pour
 * qu'il apparaisse dans les listes sans attendre le delta poll.
 *
 * Deux gardes : la table doit avoir déjà été hydratée (sinon on créerait un
 * cache d'une seule ligne, que les pages prendraient pour la table entière), et
 * un record déjà connu n'est pas remplacé — la charge utile d'un `created` est
 * complète, mais celle qu'on a peut être plus récente.
 */
export function insertRecord(tableName, row) {
  if (!row?.id || !isTableHydrated(tableName)) return false
  const s = ensureStore(tableName)
  if (s.data.has(row.id)) return false
  s.data.set(row.id, { ...row })
  notify(tableName)
  return true
}

export function getRecord(tableName, id) {
  if (!id) return null
  return ensureStore(tableName).data.get(id) || null
}

// Méta-état pour la synchro.
export function getLastSyncTs() { return lastSyncTs }
export function setLastSyncTs(ts) { lastSyncTs = ts }

// Hooks React — re-renderent automatiquement quand la table change.
export function useTable(tableName) {
  return useSyncExternalStore(
    (cb) => {
      const s = ensureStore(tableName)
      s.listeners.add(cb)
      return () => s.listeners.delete(cb)
    },
    () => {
      const s = ensureStore(tableName)
      if (!s.snapshot) s.snapshot = Array.from(s.data.values())
      return s.snapshot
    },
    () => [], // SSR snapshot (pas utilisé ici)
  )
}

// Indique si une table a déjà été hydratée (au moins une fois).
// Utile pour les pages qui ont un fallback "ancien fetch" : si la table est
// vide *et* jamais hydratée, alors on attend / on fallback.
export function isTableHydrated(tableName) {
  const s = stores.get(tableName)
  return !!s && s.version > 0
}

// Pour debug / inspection en console (exposé sur window via App.jsx).
export function inspectStore() {
  const out = {}
  for (const [name, s] of stores.entries()) {
    out[name] = { rows: s.data.size, version: s.version }
  }
  return { tables: out, lastSyncTs }
}

// Reset complet — utilisé au logout / lors d'un re-bootstrap suite à un 410.
export function resetStore() {
  for (const tableName of stores.keys()) {
    const s = stores.get(tableName)
    s.data.clear()
    s.version++
    s.snapshot = null
    for (const fn of s.listeners) {
      try { fn() } catch {}
    }
  }
  lastSyncTs = null
}
