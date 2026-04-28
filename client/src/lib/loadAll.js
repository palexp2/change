import { readStale, writeStale } from './swr.js'

/**
 * Bulk loader: fetches all rows in a single request via `limit=all`.
 * Signature kept for backwards-compat — the `pageSize` arg is ignored.
 * Backends must support `limit === 'all'` (all list endpoints currently do).
 *
 * When `opts.cacheKey` is provided, applies stale-while-revalidate: if a cached
 * response exists for that key, renders it immediately (setLoading(false)) and
 * refetches in background, updating state when fresh data arrives.
 *
 * @param {Function} loadPage  (page, limit) => Promise<{ data: [], total: number }>
 * @param {Function} setData   React state setter
 * @param {Function} setLoading React state setter
 * @param {Object}   [opts]
 * @param {string}   [opts.cacheKey] — enables SWR; used as the storage key
 */
export async function loadProgressive(loadPage, setData, setLoading, opts = {}) {
  const { cacheKey } = opts
  const stale = cacheKey ? readStale(cacheKey) : null
  if (stale) {
    setData(stale)
    setLoading(false)
  } else {
    setLoading(true)
  }
  try {
    const res = await loadPage(1, 'all')
    const data = res?.data || []
    setData(data)
    if (cacheKey) writeStale(cacheKey, data)
  } catch {
    if (!stale) setData([])
  } finally {
    setLoading(false)
  }
}
