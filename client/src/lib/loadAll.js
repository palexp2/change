/**
 * Progressive loader: shows first page immediately, loads the rest in background.
 * @param {Function} loadPage  (page, limit) => Promise<{ data: [], total: number }>
 * @param {Function} setData   React state setter
 * @param {Function} setLoading React state setter
 * @param {number}   pageSize  rows per page (default 200)
 */
export async function loadProgressive(loadPage, setData, setLoading, pageSize = 200) {
  setLoading(true)
  try {
    const first = await loadPage(1, pageSize)
    setData(first.data)
    setLoading(false)
    if (first.total > pageSize) {
      const totalPages = Math.ceil(first.total / pageSize)
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) => loadPage(i + 2, pageSize))
      )
      setData(first.data.concat(...rest.map(r => r.data)))
    }
  } catch {
    setLoading(false)
  }
}
