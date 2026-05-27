// Persistance du dataStore dans IndexedDB pour démarrage instantané au reload.
//
// Stratégie : on snapshote toutes les tables une seule fois après chaque
// bootstrap réussi (gros write, mais infrequent). Au démarrage suivant on
// rehydrate depuis IDB → l'app est utilisable immédiatement → un delta
// rattrape les changements depuis snapshot_ts. Si gap > 48h le serveur
// répond 410 et on refait un full bootstrap.
//
// On ne persiste *pas* après chaque delta — ce serait 14k+ rows à re-écrire
// fréquemment. Le store en mémoire reste l'autorité ; IDB n'est qu'un cache
// de démarrage. Conséquence : la table IDB peut être "stale" si l'utilisateur
// quitte/revient — c'est rattrapé par le delta au démarrage.

const DB_NAME = 'erp_data_store'
const DB_VERSION = 1
const STORE_NAME = 'tables'
const META_KEY = '__meta__'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

// Persiste un snapshot complet { tables: { <name>: { columns, rows } }, snapshot_ts }.
// Une seule transaction → atomique : tout ou rien.
export async function persistSnapshot({ tables, snapshot_ts }) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    // Reset complet — évite que d'anciennes tables non-cachées traînent.
    store.clear()
    for (const [name, payload] of Object.entries(tables)) {
      store.put(payload, name)
    }
    store.put({ snapshot_ts, persisted_at: new Date().toISOString() }, META_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// Lit le snapshot persisté. Renvoie { tables, snapshot_ts } ou null si vide.
export async function loadSnapshot() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const tables = {}
    let meta = null
    const req = store.openCursor()
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) {
        if (cursor.key === META_KEY) meta = cursor.value
        else tables[cursor.key] = cursor.value
        cursor.continue()
      } else {
        if (!meta || Object.keys(tables).length === 0) resolve(null)
        else resolve({ tables, snapshot_ts: meta.snapshot_ts, persisted_at: meta.persisted_at })
      }
    }
    req.onerror = () => reject(req.error)
  })
}

// Vide tout (au logout / reset complet).
export async function clearSnapshot() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
