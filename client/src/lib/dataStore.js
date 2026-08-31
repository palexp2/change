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
