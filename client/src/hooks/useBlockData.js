import { useState, useEffect, useRef } from 'react'

const BASE = '/erp/api'

function getToken() {
  return localStorage.getItem('erp_token')
}

/**
 * Fetche les données agrégées d'un bloc via GET /api/interfaces/blocks/:id/data.
 * Re-fetche quand filterValues changent.
 */
export function useBlockData(blockId, filterValues) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const prevFiltersRef = useRef(null)

  useEffect(() => {
    const filtersStr = JSON.stringify(filterValues ?? {})
    if (filtersStr === prevFiltersRef.current && data !== null) return
    prevFiltersRef.current = filtersStr

    let cancelled = false
    setLoading(true)

    const qs = new URLSearchParams()
    if (filterValues && Object.keys(filterValues).length > 0) {
      qs.set('filter_values', JSON.stringify(filterValues))
    }

    const token = getToken()
    fetch(`${BASE}/interfaces/blocks/${blockId}/data?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.json())
      .then(result => {
        if (!cancelled) { setData(result); setError(null) }
      })
      .catch(err => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, JSON.stringify(filterValues ?? {})])

  return { data, loading, error }
}
