import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config()

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production'

const clients = new Set()

export function createRealtimeServer(httpServer) {
  if (process.env.REALTIME_ENABLED !== 'true') {
    console.log('Realtime WebSocket: disabled (set REALTIME_ENABLED=true to enable)')
    return
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws) => {
    let authenticated = false

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Authentication timeout')
    }, 5000)

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString())
        if (data.type === 'auth') {
          jwt.verify(data.token, JWT_SECRET)
          authenticated = true
          clearTimeout(authTimeout)
          clients.add(ws)
          ws.send(JSON.stringify({ type: 'auth:success' }))
        }
      } catch {
        ws.close(4002, 'Invalid token')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      clients.delete(ws)
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
 * Broadcast a message to all connected clients.
 * Fire-and-forget — never throws.
 */
export function broadcast(message) {
  const json = JSON.stringify(message)
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(json) // WebSocket.OPEN = 1
    } catch {}
  }
}

// Alias for backward compatibility — both do the same thing now
export const broadcastAll = broadcast
