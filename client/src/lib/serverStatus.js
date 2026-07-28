// Tiny pub/sub for "is the API server reachable?".
//
// Signals come from two places:
//   - lib/realtime.js : WS reconnect failed / WS authed successfully
//   - lib/api.js      : fetch() threw (network error) / 5xx returned / 2xx returned
//
// Subscribers (currently <ServerOfflineOverlay>) re-render when the state flips.
//
// Debounce : un appel à markOffline() n'est pas répercuté immédiatement —
// on attend DEBOUNCE_MS pour voir si un markOnline() arrive entre-temps. Ça
// élimine les flashs d'overlay sur les blips ultra-courts (reconnexion WS,
// requête transiente qui rate puis la suivante passe).

const DEBOUNCE_MS = 400

let offline = false
let lastReason = null
let pendingTimer = null
let knownBootId = null
const subs = new Set()

function emit() {
  for (const fn of subs) {
    try { fn(offline, lastReason) } catch (e) { console.error('serverStatus subscriber error', e) }
  }
}

// reason : 'network' | 'gateway' | 'ws-close' | string libre — affiché par
// l'overlay pour donner un indice de ce qui cloche. Le dernier reason gagne.
export function markOffline(reason) {
  if (reason) lastReason = reason
  if (offline) return
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    offline = true
    emit()
  }, DEBOUNCE_MS)
}

export function markOnline() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
  if (!offline) {
    if (lastReason) lastReason = null
    return
  }
  offline = false
  lastReason = null
  emit()
}

export function getIsOffline() { return offline }
export function getReason() { return lastReason }

export function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

// Boot id — alimenté par api.js depuis le header X-Boot-Id de chaque réponse.
// Permet à l'overlay de distinguer "le serveur a redémarré" d'un simple blip,
// et de détecter un déploiement même sans interruption WS (`pm2 restart`
// rapide) — sinon le client tournerait indéfiniment sur l'ancien bundle.
const restartSubs = new Set()

export function noteBootId(id) {
  if (!id) return
  if (knownBootId === null) {
    knownBootId = id
    return
  }
  if (knownBootId !== id) {
    // Le boot_id a changé sans qu'on soit passé par "offline" — le serveur a
    // été redémarré (typiquement un déploiement). On NE met PAS à jour
    // knownBootId : l'overlay/le handler doivent voir l'écart pour décider
    // de reload. Notifie les subscribers (ServerOfflineOverlay) ; ils
    // déclencheront le reload après un court délai.
    for (const fn of restartSubs) {
      try { fn(id) } catch (e) { console.error('serverRestart subscriber error', e) }
    }
  }
}

export function getKnownBootId() { return knownBootId }

// Accepte un nouveau boot_id comme référence SANS reload — appelé quand le
// handler de restart a vérifié que le bundle client n'a pas changé (pm2
// restart sans rebuild). Sans ça, chaque réponse suivante re-déclencherait
// les subscribers de restart.
export function acceptBootId(id) {
  if (id) knownBootId = id
}

export function subscribeServerRestart(fn) {
  restartSubs.add(fn)
  return () => restartSubs.delete(fn)
}
