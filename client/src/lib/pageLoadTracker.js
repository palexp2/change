// Mesure le temps de chargement complet d'une page SPA : du changement de
// route jusqu'à ce que toutes les requêtes API initiales soient settled
// (queue vide pendant ~300ms). Si le total ≥ 500ms, on l'envoie au backend
// pour affichage dans la section Santé de l'application.

const POST_URL = '/erp/api/telemetry/page-load'
const SETTLE_MS = 300
const THRESHOLD_MS = 500

let pendingCount = 0
let pageStart = (typeof performance !== 'undefined' ? performance.now() : Date.now())
let pageUrl = typeof location !== 'undefined' ? location.pathname + location.search : '/'
let hasSeenFetch = false
let settleTimer = null
let logged = false

function send(url, elapsed) {
  const token = localStorage.getItem('erp_token')
  if (!token) return
  fetch(POST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ url, load_ms: elapsed }),
    keepalive: true,
  }).catch(() => {})
}

function commit() {
  if (logged) return
  const elapsed = Math.round(performance.now() - pageStart)
  logged = true
  if (elapsed >= THRESHOLD_MS) send(pageUrl, elapsed)
}

export function onFetchStart() {
  if (logged) return
  hasSeenFetch = true
  pendingCount++
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
}

export function onFetchEnd() {
  if (logged) return
  pendingCount = Math.max(0, pendingCount - 1)
  if (pendingCount === 0 && hasSeenFetch) {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(commit, SETTLE_MS)
  }
}

export function notifyNavigation(url) {
  // Si la page précédente n'a jamais settled (utilisateur a navigué pendant
  // le loading), on la commit quand même avec ce qu'on a.
  if (!logged && hasSeenFetch) commit()
  pageStart = performance.now()
  pageUrl = url
  hasSeenFetch = false
  logged = false
  pendingCount = 0
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
}
