// Minimal request-level cache to support hover-prefetch on nav links.
//
// Usage:
//   - Hover on a nav link → prefetch(path) fires the request, stashes the
//     in-flight promise in CACHE keyed by path.
//   - When the page mounts and calls api.get(path), request() in api.js
//     consults consume(path) and returns the cached promise (dedup + reuse).
//   - Mutations (POST/PUT/PATCH/DELETE) call invalidate(prefix) to drop any
//     stale entries for the affected resource.
//
// Constraints:
//   - Only caches GET. Never caches errors.
//   - Short TTL so concurrent users / background syncs don't see very stale
//     data if the cache survives unusually long.
//   - Cache keys are the exact path+querystring; the caller (nav prefetch map)
//     must match what the page actually fetches.

const CACHE = new Map() // path → { promise, expiresAt }
const TTL_MS = 30_000

export function cacheGet(path) {
  const hit = CACHE.get(path)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) { CACHE.delete(path); return null }
  return hit.promise
}

export function cacheSet(path, promise) {
  CACHE.set(path, { promise, expiresAt: Date.now() + TTL_MS })
  // Never cache failures — drop the entry if the request rejects.
  promise.catch(() => {
    if (CACHE.get(path)?.promise === promise) CACHE.delete(path)
  })
}

export function invalidate(prefix) {
  for (const k of CACHE.keys()) {
    if (k.startsWith(prefix)) CACHE.delete(k)
  }
}

// Called by nav hover. `getter` is a function returning the api call's
// promise (e.g. () => api.interactions.list({ limit: 'all', offset: 0 })).
// It goes through request() in api.js, which will populate CACHE for us.
export function prefetch(getter) {
  try {
    // Fire-and-forget; swallow errors so a failed prefetch never throws to UI.
    Promise.resolve(getter()).catch(() => {})
  } catch {}
}
