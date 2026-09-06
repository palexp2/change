// Singleton WebSocket client for the ERP realtime channel.
//
// Wire protocol (mirrors server/src/services/realtime.js):
//   client → server : { type: 'auth', token }                          // first message
//                     { type: 'subscribe' | 'unsubscribe', channel }
//   server → client : { type: 'auth:success' }
//                     { type: 'subscribed', channel }
//                     { type: '<entity>:<verb>', channel, payload, actorUserId, ts }
//                     { type: 'sync:progress' | 'agent:task:updated' | 'agent:task:stream', ... }
//
// Re-emits legacy global events as window CustomEvent for back-compat with
// the previous Layout.jsx wiring (taskRunner, sync progress).

import { markOffline, markOnline } from './serverStatus.js'

const WS_PATH = '/erp/ws'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

const state = {
  ws: null,
  authed: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  offlineFlipTimer: null,
  /** @type {Map<string, Set<(msg: any) => void>>} */
  channelHandlers: new Map(),
  pendingSubscribes: new Set(),
}

function token() {
  return localStorage.getItem('erp_token')
}

function isOpen() {
  return state.ws && state.ws.readyState === 1 // WebSocket.OPEN
}

function send(obj) {
  if (!isOpen()) return false
  try {
    state.ws.send(JSON.stringify(obj))
    return true
  } catch { return false }
}

function flushSubscriptions() {
  for (const ch of state.channelHandlers.keys()) send({ type: 'subscribe', channel: ch })
  state.pendingSubscribes.clear()
}

function scheduleReconnect() {
  if (state.reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempts), RECONNECT_MAX_MS)
  state.reconnectAttempts++
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    open()
  }, delay)
}

function open() {
  if (state.ws && state.ws.readyState <= 1) return // already opening or open
  const t = token()
  if (!t) return
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`)
  state.ws = ws

  ws.onopen = () => {
    state.reconnectAttempts = 0
    ws.send(JSON.stringify({ type: 'auth', token: t }))
  }

  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }

    if (msg.type === 'auth:success') {
      state.authed = true
      if (state.offlineFlipTimer) { clearTimeout(state.offlineFlipTimer); state.offlineFlipTimer = null }
      markOnline()
      flushSubscriptions()
      return
    }
    if (msg.type === 'subscribed') return // ack — nothing to do

    // Back-compat global events
    if (msg.type === 'agent:task:updated') {
      window.dispatchEvent(new CustomEvent('agent:task:updated', { detail: msg.task }))
      return
    }
    if (msg.type === 'agent:task:stream') {
      window.dispatchEvent(new CustomEvent('agent:task:stream', { detail: msg }))
      return
    }
    if (msg.type === 'agent:settings:updated') {
      window.dispatchEvent(new CustomEvent('agent:settings:updated', { detail: msg.settings }))
      return
    }
    if (msg.type === 'agent:backlog:updated') {
      window.dispatchEvent(new CustomEvent('agent:backlog:updated', { detail: msg }))
      return
    }
    // Travaux (file de prompts, suggestions, travaux récurrents) : un seul
    // événement par liste, la page recharge la liste concernée.
    if (msg.type?.startsWith('travaux:')) {
      window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }))
      return
    }
    if (msg.type === 'sync:progress') {
      window.dispatchEvent(new CustomEvent('sync:progress', { detail: msg }))
      return
    }

    // Événement routé par canal. Le serveur tague le message avec TOUS les
    // canaux auxquels cette socket est abonnée (`channels`) : une fiche ouverte
    // par-dessus sa liste écoute `order:<id>` ET `orders:list`, et les deux
    // handlers doivent tourner. `channel` seul est le repli.
    const chans = Array.isArray(msg.channels) && msg.channels.length
      ? msg.channels
      : (msg.channel ? [msg.channel] : [])
    for (const ch of chans) {
      const handlers = state.channelHandlers.get(ch)
      if (!handlers) continue
      for (const fn of handlers) {
        try { fn(chans.length > 1 ? { ...msg, channel: ch } : msg) }
        catch (e) { console.error('realtime handler error', e) }
      }
    }
  }

  ws.onclose = (ev) => {
    state.authed = false
    state.ws = null
    // 4001 (auth timeout) and 4002 (invalid token) are auth failures, not server-down.
    // Anything else (1006 abnormal closure, etc.) after we had a token means the
    // server is likely restarting or unreachable.
    //
    // On NE flip PAS l'overlay offline immédiatement — un redémarrage normal
    // du serveur (pm2 restart, déploiement) coupe les WS pendant ~1-2s avant
    // que le reconnect aboutisse. Le débounce de 400ms de markOffline est trop
    // court, ce qui flashait la modale "Connexion perdue" à chaque déploiement.
    // On laisse passer la première tentative de reconnect (1s + auth ~200ms) ;
    // si elle réussit, markOnline() depuis ws.onmessage('auth:success') annule
    // tout, sinon on flip après ~2.5s.
    if (ev && ev.code !== 4001 && ev.code !== 4002 && token()) {
      if (state.offlineFlipTimer) clearTimeout(state.offlineFlipTimer)
      state.offlineFlipTimer = setTimeout(() => {
        state.offlineFlipTimer = null
        if (!state.authed) markOffline(`ws-close-${ev.code || 'unknown'}`)
      }, 2500)
    }
    if (token()) scheduleReconnect()
  }

  ws.onerror = () => {} // close will fire next
}

export function connect() {
  if (typeof import.meta !== 'undefined' && !import.meta.env.VITE_REALTIME_ENABLED) return
  open()
}

export function disconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
  state.channelHandlers.clear()
  if (state.ws) {
    try { state.ws.close() } catch {}
    state.ws = null
  }
  state.authed = false
}

/**
 * Subscribe to a channel. Returns an unsubscribe function.
 * Safe to call before connect — subscriptions are sent once authed.
 */
export function subscribe(channel, handler) {
  let set = state.channelHandlers.get(channel)
  if (!set) {
    set = new Set()
    state.channelHandlers.set(channel, set)
    if (state.authed) send({ type: 'subscribe', channel })
    else state.pendingSubscribes.add(channel)
  }
  set.add(handler)

  return () => {
    const s = state.channelHandlers.get(channel)
    if (!s) return
    s.delete(handler)
    if (s.size === 0) {
      state.channelHandlers.delete(channel)
      send({ type: 'unsubscribe', channel })
    }
  }
}
