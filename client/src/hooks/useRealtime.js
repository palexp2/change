import { useEffect, useRef, useCallback } from 'react'

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
const HEARTBEAT_INTERVAL = 25_000
const RECONNECT_BASE = 1_000
const RECONNECT_MAX = 30_000

let sharedSocket = null
let sharedListeners = new Map() // id → {tableId, callback}
let reconnectTimer = null
let heartbeatTimer = null
let reconnectDelay = RECONNECT_BASE
let listenerId = 0

function getToken() {
  return localStorage.getItem('erp_token')
}

function connect() {
  if (sharedSocket && (sharedSocket.readyState === WebSocket.OPEN || sharedSocket.readyState === WebSocket.CONNECTING)) return

  const token = getToken()
  if (!token) return

  sharedSocket = new WebSocket(WS_URL)

  sharedSocket.onopen = () => {
    reconnectDelay = RECONNECT_BASE
    sharedSocket.send(JSON.stringify({ type: 'auth', token }))
    heartbeatTimer = setInterval(() => {
      if (sharedSocket.readyState === WebSocket.OPEN) sharedSocket.send(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_INTERVAL)
  }

  sharedSocket.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.type === 'pong') return
    for (const { tableId, callback } of sharedListeners.values()) {
      if (!tableId || msg.table_id === tableId) callback(msg)
    }
  }

  sharedSocket.onerror = () => {}

  sharedSocket.onclose = () => {
    clearInterval(heartbeatTimer)
    sharedSocket = null
    if (sharedListeners.size > 0) scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX)
  }, reconnectDelay)
}

function disconnect() {
  clearTimeout(reconnectTimer)
  clearInterval(heartbeatTimer)
  reconnectTimer = null
  if (sharedSocket) {
    sharedSocket.onclose = null
    sharedSocket.close()
    sharedSocket = null
  }
}

// Subscribe to realtime events for a given tableId (or all if null)
export function useRealtime(tableId, callback) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  const stableCallback = useCallback((msg) => cbRef.current(msg), [])

  useEffect(() => {
    const id = ++listenerId
    sharedListeners.set(id, { tableId, callback: stableCallback })
    connect()

    return () => {
      sharedListeners.delete(id)
      if (sharedListeners.size === 0) disconnect()
    }
  }, [tableId, stableCallback])
}
