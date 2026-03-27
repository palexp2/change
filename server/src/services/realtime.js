import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config()

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production'

// tenantId → Set<ws>
const clients = new Map()

export function createRealtimeServer(httpServer) {
  if (process.env.REALTIME_ENABLED !== 'true') {
    console.log('Realtime WebSocket: disabled (set REALTIME_ENABLED=true to enable)')
    return
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws) => {
    let tenantId = null
    let authenticated = false

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Authentication timeout')
    }, 5000)

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString())
        if (data.type === 'auth') {
          const decoded = jwt.verify(data.token, JWT_SECRET)
          tenantId = decoded.tenant_id
          authenticated = true
          clearTimeout(authTimeout)

          if (!clients.has(tenantId)) clients.set(tenantId, new Set())
          clients.get(tenantId).add(ws)

          ws.send(JSON.stringify({ type: 'auth:success' }))
        }
      } catch {
        ws.close(4002, 'Invalid token')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      if (tenantId && clients.has(tenantId)) {
        clients.get(tenantId).delete(ws)
        if (clients.get(tenantId).size === 0) clients.delete(tenantId)
      }
    })

    ws.on('error', () => {}) // Swallow per-socket errors

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
  })

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate()
      ws.isAlive = false
      ws.ping()
    })
  }, 30000)

  wss.on('close', () => clearInterval(heartbeat))

  console.log('Realtime WebSocket: enabled on /ws')
}

/**
 * Broadcast a message to all connected clients of a tenant.
 * Fire-and-forget — never throws.
 */
export function broadcast(tenantId, message) {
  if (!tenantId || !clients.has(tenantId)) return
  const json = JSON.stringify(message)
  for (const ws of clients.get(tenantId)) {
    try {
      if (ws.readyState === 1) ws.send(json) // WebSocket.OPEN = 1
    } catch {}
  }
}
