import { useState, useEffect, useCallback } from 'react'
import api from './api.js'

// Returns { status, anyRunning }
// status: { gmail: { running, startedAt, endedAt, error }, drive: {...}, ... }
// anyRunning: boolean — true if at least one sync is in progress
export function useSyncStatus(intervalMs = 5000) {
  const [status, setStatus] = useState({})

  const fetch = useCallback(async () => {
    try {
      const s = await api.connectors.syncStatus()
      setStatus(s)
    } catch {
      // silently ignore — not critical
    }
  }, [])

  useEffect(() => {
    fetch()
    const id = setInterval(fetch, intervalMs)
    return () => clearInterval(id)
  }, [fetch, intervalMs])

  const anyRunning = Object.values(status).some(s => s.running)

  return { status, anyRunning }
}
