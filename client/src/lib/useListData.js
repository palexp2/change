import { useState, useEffect, useCallback, useRef } from 'react'
import { useTable, isTableHydrated } from './dataStore.js'
import { sync as syncStore } from './dataSync.js'
import { loadProgressive } from './loadAll.js'
import { useEntityListRealtime } from './useRealtimeChannel.js'

// Une page liste lit ses lignes soit dans le cache global (`table`), soit par
// fetch (`fetch(page, limit)` + realtime `<entity>:list`). Même retour dans les
// deux cas : { rows, setRows, loading, reload }.
export function useListData({ table, fetch, realtime, cacheKey, deps = [] } = {}) {
  const cached = useTable(table || '__none__')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(!table)
  const fetchRef = useRef(fetch)
  fetchRef.current = fetch
  const depsKey = JSON.stringify(deps)

  const load = useCallback(async () => {
    if (!fetchRef.current) return
    await loadProgressive(fetchRef.current, setRows, setLoading, { cacheKey })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, depsKey])

  useEffect(() => { load() }, [load])

  const rt = typeof realtime === 'string' ? { entity: realtime } : (realtime || {})
  useEntityListRealtime(rt.entity, setRows, rt)

  if (table) return { rows: cached, setRows: () => {}, loading: !isTableHydrated(table), reload: syncStore }
  return { rows, setRows, loading, reload: load }
}
