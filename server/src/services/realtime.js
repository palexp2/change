import { WebSocketServer } from 'ws'
import { verifySession } from './sessionSecurity.js'
import { canReceiveChannel } from './dataAccess.js'

// Map<ws, { userId: string|null, channels: Set<string> }>
const clients = new Map()

export function createRealtimeServer(httpServer) {
  if (process.env.REALTIME_ENABLED !== 'true') {
    console.log('Realtime WebSocket: disabled (set REALTIME_ENABLED=true to enable)')
    return
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/erp/ws', maxPayload: 64 * 1024 })

  wss.on('connection', (ws) => {
    let authenticated = false

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Authentication timeout')
    }, 5000)

    ws.on('message', (message) => {
      let data
      try {
        data = JSON.parse(message.toString())
      } catch {
        return // ignore non-JSON
      }

      if (data.type === 'auth') {
        try {
          const user = verifySession(data.token)
          authenticated = true
          clearTimeout(authTimeout)
          clients.set(ws, { userId: user.id, user, token: data.token, channels: new Set() })
          ws.send(JSON.stringify({ type: 'auth:success' }))
        } catch {
          ws.close(4002, 'Invalid token')
        }
        return
      }

      if (!authenticated) return // ignore other messages until authed

      const state = clients.get(ws)
      if (!state || !currentUser(ws)) return

      if (data.type === 'subscribe' && typeof data.channel === 'string') {
        if (state.channels.size >= 100 || !canReceiveChannel(state.user, data.channel)) return
        state.channels.add(data.channel)
        ws.send(JSON.stringify({ type: 'subscribed', channel: data.channel }))
        return
      }
      if (data.type === 'unsubscribe' && typeof data.channel === 'string') {
        state.channels.delete(data.channel)
        return
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      clients.delete(ws)
    })

    ws.on('error', () => {}) // swallow per-socket errors

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
  })

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (clients.has(ws) && !currentUser(ws)) return
      if (!ws.isAlive) return ws.terminate()
      ws.isAlive = false
      ws.ping()
    })
  }, 30000)

  wss.on('close', () => clearInterval(heartbeat))
  // Le serveur HTTP ne ferme pas le WebSocketServer attaché : libérer aussi
  // son heartbeat quand l'application (ou un test) ferme le serveur HTTP.
  httpServer.once('close', () => wss.close())

  console.log('Realtime WebSocket: enabled on /erp/ws')
  return wss
}

function currentUser(ws) {
  try {
    const state = clients.get(ws)
    if (!state) return null
    state.user = verifySession(state.token)
    return state.user
  } catch {
    clients.delete(ws)
    ws.close(4002, 'Session revoked')
    return null
  }
}

/**
 * Send to every authenticated socket, regardless of channel subscriptions.
 * Used for legacy global events (sync:progress, agent:task:*).
 */
export function broadcastAll(message) {
  const json = JSON.stringify(message)
  for (const ws of clients.keys()) {
    const user = currentUser(ws)
    if (!user || !canReceiveChannel(user, message.type)) continue
    try {
      if (ws.readyState === 1) ws.send(json)
    } catch {}
  }
}

/**
 * Send to sockets subscribed to `channel`. The wire message includes the
 * channel so clients can route to the right handler when subscribed to many.
 */
export function broadcast(channel, message) {
  const wire = JSON.stringify({ ...message, channel })
  for (const [ws, state] of clients.entries()) {
    const user = currentUser(ws)
    if (!user || !canReceiveChannel(user, channel) || !canReceiveChannel(user, message.type) || !state.channels.has(channel)) continue
    try {
      if (ws.readyState === 1) ws.send(wire)
    } catch {}
  }
}

/**
 * Send `message` to the union of sockets subscribed to any of `channels`.
 * Each socket receives the message at most once, mais TAGUÉ AVEC TOUS les
 * canaux auxquels il est abonné (`channels`), pas seulement le premier.
 *
 * Pourquoi : une fiche s'ouvre toujours en panneau latéral PAR-DESSUS sa liste
 * (règle de design). Le navigateur est donc abonné à `orders:list` ET à
 * `order:<id>` en même temps. Tagué avec le seul premier canal trouvé, le
 * message n'était routé que vers le handler de la LISTE : la fiche ouverte
 * n'était jamais mise à jour en direct. `channel` reste renseigné (premier
 * canal) pour les clients qui ne connaissent pas encore `channels`.
 */
export function emit(channels, message) {
  const list = Array.isArray(channels) ? channels : [channels]
  for (const [ws, state] of clients.entries()) {
    const user = currentUser(ws)
    if (!user || !canReceiveChannel(user, message.type)) continue
    const matched = list.filter(ch => state.channels.has(ch) && canReceiveChannel(user, ch))
    if (!matched.length) continue
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ ...message, channel: matched[0], channels: matched }))
    } catch {}
  }
}
