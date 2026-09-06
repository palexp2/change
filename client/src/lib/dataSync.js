// Orchestre le cache client (voir dataStore.js) :
//   - bootstrap initial au login (GET /api/bootstrap)
//   - delta polling toutes les POLL_INTERVAL_MS (GET /api/bootstrap/delta?since=...)
//   - delta immédiat au retour de veille (visibilitychange) ou reconnexion WS
//   - full re-bootstrap si le serveur répond 410 (since trop vieux) ou si le
//     gap depuis lastSync dépasse RETENTION_HOURS
//
// On NE branche PAS le WebSocket sur le dataStore : les payloads WS contiennent
// des champs joints (company_name, items_count, …) qui ne correspondent pas au
// shape "row de table brute" du store. Les pages qui veulent une update <10s
// continuent de subscribe au WS directement (comme aujourd'hui) ; le dataStore
// se rafraîchit via delta polling, ce qui suffit pour la majorité des cas.

import {
  hydrateTable, applyDelta, setLastSyncTs, getLastSyncTs, resetStore,
} from './dataStore.js'
import { persistSnapshot, loadSnapshot, clearSnapshot } from './dataStorePersist.js'

const POLL_INTERVAL_MS = 10_000
const BASE = '/erp/api'

let pollTimer = null
let inFlight = null
let started = false
// Empreinte de la forme du snapshot (tables + colonnes) reçue du serveur. Si le
// serveur en renvoie une différente — typiquement un champ personnalisé ajouté,
// donc une colonne de plus dans la vue <table>_v —, le cache local n'a pas cette
// colonne sur les records inchangés : on refait un bootstrap complet plutôt que
// de laisser le champ vide indéfiniment.
let columnsSignature = null

function token() {
  return localStorage.getItem('erp_token')
}

async function fetchJson(path) {
  const t = token()
  if (!t) throw new Error('no token')
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${t}` },
    cache: 'no-store',
  })
  if (res.status === 410) {
    const err = new Error('retention exceeded')
    err.status = 410
    throw err
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

async function doBootstrap() {
  const start = performance.now()
  const data = await fetchJson('/bootstrap')
  resetStore()
  for (const [tableName, payload] of Object.entries(data.tables || {})) {
    hydrateTable(tableName, payload, { replace: true })
  }
  columnsSignature = data.columns_signature || null
  setLastSyncTs(data.snapshot_ts)
  const ms = Math.round(performance.now() - start)
  console.log(`[dataSync] bootstrap loaded ${Object.keys(data.tables || {}).length} tables in ${ms}ms`)
  // Persiste en arrière-plan — la promesse n'est pas attendue pour ne pas
  // bloquer l'UI. Une erreur d'IDB est loggée mais n'empêche pas le fonctionnement.
  persistSnapshot(data).catch((err) => console.warn('[dataSync] persist failed:', err.message))
  return data
}

// Tente de rehydrate le store depuis IndexedDB. Renvoie true si OK.
async function hydrateFromCache() {
  try {
    const cached = await loadSnapshot()
    if (!cached) return false
    resetStore()
    for (const [tableName, payload] of Object.entries(cached.tables)) {
      hydrateTable(tableName, payload, { replace: true })
    }
    columnsSignature = cached.columns_signature || null
    setLastSyncTs(cached.snapshot_ts)
    console.log(`[dataSync] hydrated from IndexedDB (snapshot_ts=${cached.snapshot_ts})`)
    return true
  } catch (err) {
    console.warn('[dataSync] hydrateFromCache failed:', err.message)
    return false
  }
}

async function doDelta() {
  const since = getLastSyncTs()
  if (!since) {
    // Pas de since → fallback à bootstrap.
    return doBootstrap()
  }
  try {
    const data = await fetchJson(`/bootstrap/delta?since=${encodeURIComponent(since)}`)
    // La forme du snapshot a bougé (champ personnalisé créé/supprimé, colonne
    // ajoutée au serveur) : un delta ne remplirait la nouvelle colonne que sur
    // les records modifiés → on recharge tout.
    if (data.columns_signature && data.columns_signature !== columnsSignature) {
      console.warn('[dataSync] colonnes du snapshot modifiées — re-bootstrap')
      return doBootstrap()
    }
    let totalChanges = 0
    for (const [tableName, delta] of Object.entries(data.tables || {})) {
      applyDelta(tableName, delta)
      totalChanges += (delta.upsert?.length || 0) + (delta.delete?.length || 0)
    }
    setLastSyncTs(data.snapshot_ts)
    if (totalChanges > 0) console.log(`[dataSync] delta applied ${totalChanges} changes`)
    return data
  } catch (err) {
    if (err.status === 410) {
      console.warn('[dataSync] delta rejected (410) — re-bootstrapping')
      return doBootstrap()
    }
    throw err
  }
}

// Lance une synchro (bootstrap ou delta selon l'état). Sérialise — si une
// synchro est déjà en cours, retourne sa promise.
export function sync() {
  if (inFlight) return inFlight
  const since = getLastSyncTs()
  inFlight = (since ? doDelta() : doBootstrap())
    .catch((err) => {
      if (err.status !== 410) console.error('[dataSync] sync failed:', err.message)
    })
    .finally(() => { inFlight = null })
  return inFlight
}

function schedulePoll() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') sync()
  }, POLL_INTERVAL_MS)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    // Au retour de veille : synchro immédiate. Si le gap est > RETENTION_HOURS,
    // le serveur répondra 410 et sync() fera un full bootstrap.
    sync()
  }
}

// Démarre le cache : rehydrate IDB si dispo (instant) puis delta pour rattraper.
// Si pas d'IDB, fait un full bootstrap. Appelé une fois après login.
export async function startDataSync() {
  if (started) return
  started = true
  try {
    const hadCache = await hydrateFromCache()
    if (hadCache) {
      // Rattrape les changements depuis le snapshot persisté.
      // doDelta() gère le cas 410 → re-bootstrap automatique.
      try { await doDelta() } catch (err) {
        if (err?.status !== 410) console.warn('[dataSync] initial delta failed:', err.message)
      }
    } else {
      await doBootstrap()
    }
  } catch (err) {
    console.error('[dataSync] initial sync failed:', err.message)
    started = false
    throw err
  }
  schedulePoll()
  document.addEventListener('visibilitychange', onVisibilityChange)
}

// Stoppe tout (au logout).
export async function stopDataSync() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  resetStore()
  // Efface aussi la persistance — au prochain login d'un autre user, on ne
  // veut pas hydrater avec les données du précédent (qui pourrait avoir un
  // autre rôle/visibilité).
  try { await clearSnapshot() } catch {}
  columnsSignature = null
  started = false
}

export function isDataSyncStarted() { return started }
