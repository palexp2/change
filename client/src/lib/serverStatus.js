// Tiny pub/sub for "is the API server reachable?".
//
// Signals come from two places:
//   - lib/realtime.js : WS reconnect failed / WS authed successfully
//   - lib/api.js      : fetch() threw (network error) / 5xx returned / 2xx returned
//
// Subscribers (currently <ServerOfflineOverlay>) re-render when the state flips.

let offline = false
const subs = new Set()

function emit() {
  for (const fn of subs) {
    try { fn(offline) } catch (e) { console.error('serverStatus subscriber error', e) }
  }
}

export function markOffline() {
  if (offline) return
  offline = true
  emit()
}

export function markOnline() {
  if (!offline) return
  offline = false
  emit()
}

export function getIsOffline() {
  return offline
}

export function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
