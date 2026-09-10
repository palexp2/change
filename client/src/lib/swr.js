// Stale-while-revalidate storage layer — survives page reload / tab close.
//
// Pages opt in by passing `cacheKey` to loadProgressive. On first visit the
// fetch runs cold; its result is saved here. On subsequent visits (even after
// reload or next day) we hand back the saved data synchronously so the UI
// paints instantly, while the background fetch refreshes it.
//
// Constraints:
//   - Per-entry size guard (~3 MB) to stay under the ~5 MB localStorage quota.
//     Pages with fatter list payloads silently skip the cache — no regression,
//     they behave as today.
//   - 24h TTL: a stale value older than that is discarded, user sees a loader.
//   - Mutations invalidate by prefix so we don't serve a record that was just
//     edited/deleted.

const PREFIX = 'erp.swr:'
const MAX_SIZE_BYTES = 3 * 1024 * 1024
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function readStale(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const { data, at } = JSON.parse(raw)
    if (!at || Date.now() - at > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key)
      return null
    }
    return data
  } catch {
    return null
  }
}

export function writeStale(key, data) {
  try {
    const payload = JSON.stringify({ data, at: Date.now() })
    if (payload.length > MAX_SIZE_BYTES) return
    localStorage.setItem(PREFIX + key, payload)
  } catch {
    // Quota exceeded, serialization error, storage disabled — skip silently.
  }
}

// Ne garde que les `keep` entrées les plus récentes sous `prefix`, et jette les
// autres. Pour les caches indexés par table/module (une entrée par table
// configurée) : sans ce ménage, visiter la configuration des champs de vingt
// tables empilerait vingt payloads de ~80 ko et finirait par saturer le quota
// localStorage — ce qui ferait silencieusement échouer TOUS les writeStale.
export function pruneStale(prefix, keep) {
  try {
    const full = PREFIX + prefix
    const entries = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(full)) continue
      let at = 0
      try { at = JSON.parse(localStorage.getItem(k))?.at || 0 } catch {}
      entries.push({ k, at })
    }
    if (entries.length <= keep) return
    entries.sort((a, b) => b.at - a.at)
    for (const e of entries.slice(keep)) localStorage.removeItem(e.k)
  } catch {}
}

export function invalidateStale(prefix) {
  try {
    const full = PREFIX + prefix
    // Collect first; removing while iterating Object.keys is fine but explicit
    // is safer if the implementation changes.
    const toDelete = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(full)) toDelete.push(k)
    }
    for (const k of toDelete) localStorage.removeItem(k)
  } catch {}
}
