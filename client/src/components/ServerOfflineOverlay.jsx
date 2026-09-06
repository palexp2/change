import { useEffect, useState, useRef } from 'react'
import { Loader2, ServerOff, RefreshCw, WifiOff } from 'lucide-react'
import { subscribe, getIsOffline, getReason, getKnownBootId, markOnline, subscribeServerRestart, acceptBootId } from '../lib/serverStatus.js'
import { sync } from '../lib/dataSync.js'
import { connect as reconnectRealtime } from '../lib/realtime.js'

// Fullscreen overlay shown when the server is unreachable. Pings /api/health
// every 10 s; on success, compare the returned boot_id with the one we saw
// before the outage:
//   - boot_id identique ou inconnu → simple blip réseau → on masque l'overlay
//     SANS recharger la page : un reload fermerait toute modale ouverte et
//     perdrait les modifications en cours (ex. modale de modification d'une
//     automation système). Les données sont rattrapées via un delta dataSync
//     immédiat + reconnexion WS.
//   - boot_id changé → pm2 a redémarré. On vérifie alors si le bundle JS
//     servi a changé (hash Vite dans index.html) :
//       - bundle identique (pm2 restart sans rebuild client — cas fréquent) →
//         même traitement qu'un blip : pas de reload, resync en place.
//       - bundle différent (vrai déploiement frontend) → message "Mise à jour
//         de l'app en cours" puis reload pour charger le nouveau code.
//       - indéterminé (le serveur redémarre encore, `/erp/` répond 502) → on
//         réessaie, on ne recharge JAMAIS sur un doute. Voir bundleState().
//
// L'apparition est debouncée 400 ms côté serverStatus.js — les blips < 400 ms
// (reconnexion WS, requête transiente) ne déclenchent jamais l'overlay.
//
// Triggered by lib/serverStatus → see realtime.js (WS abnormal close) and
// api.js (network error / 502 / 503 / 504).

// Compare le bundle JS actuellement chargé avec celui que le serveur sert.
// Vite content-hash les assets (dist/assets/index-XXXX.js) : si le hash de
// index.html correspond au <script> déjà chargé, un reload ne changerait
// rien — on l'évite pour préserver l'état de la page (modales ouvertes,
// champs en cours d'édition).
//
// Trois réponses, pas deux. L'ancienne version renvoyait `true` (= recharge) dès
// qu'elle ne savait pas : fetch en échec, réponse non-ok, marqueur introuvable.
// Or elle est appelée exactement quand le serveur vient de redémarrer, donc
// pendant les quelques secondes où `/erp/` répond 502 — le « je ne sais pas »
// était le cas NORMAL, et chaque redémarrage rechargeait tous les onglets
// ouverts. Mesuré le 2026-09-04 : la même fiche commande rechargée toute seule à
// HH:01 à chaque heure, 9,0 s de chargement à chaque fois, pendant que le
// serveur finissait de démarrer.
//
// « Je ne sais pas » ne doit donc plus valoir « recharge ». On répond 'unknown'
// et l'appelant réessaie plus tard, quand le serveur sait répondre.
const BUNDLE_SAME = 'same'
const BUNDLE_CHANGED = 'changed'
const BUNDLE_UNKNOWN = 'unknown'

async function bundleState() {
  const current = document.querySelector('script[src*="assets/index-"]')?.getAttribute('src')
  if (!current) return BUNDLE_UNKNOWN
  try {
    const res = await fetch('/erp/', { cache: 'no-store' })
    if (!res.ok) return BUNDLE_UNKNOWN
    const html = await res.text()
    const m = html.match(/assets\/index-[^"']+\.js/)
    if (!m) return BUNDLE_UNKNOWN
    return current.includes(m[0]) ? BUNDLE_SAME : BUNDLE_CHANGED
  } catch {
    return BUNDLE_UNKNOWN
  }
}

// Délai avant de redemander quand `/erp/` n'a pas su répondre. Assez long pour
// laisser le serveur finir son démarrage (schéma, migrations, watchers), assez
// court pour qu'un vrai déploiement frontend arrive dans la seconde d'après.
const BUNDLE_RECHECK_MS = 4000
const BUNDLE_MAX_RECHECKS = 8

// Interroge `/erp/` jusqu'à obtenir une réponse exploitable. Si le serveur ne
// sait toujours pas répondre après BUNDLE_MAX_RECHECKS tentatives, on rend
// 'unknown' et l'appelant NE recharge PAS : au pire l'onglet reste sur l'ancien
// bundle jusqu'à la prochaine navigation, ce qui est sans commune mesure avec
// recharger tous les onglets ouverts à chaque redémarrage.
async function resolveBundleState() {
  for (let i = 0; i < BUNDLE_MAX_RECHECKS; i++) {
    const state = await bundleState()
    if (state !== BUNDLE_UNKNOWN) return state
    await new Promise(r => setTimeout(r, BUNDLE_RECHECK_MS))
  }
  return BUNDLE_UNKNOWN
}

function describeReason(reason) {
  if (!reason) return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Nouvelle tentative de connexion en cours.',
  }
  if (reason === 'no-internet') return {
    icon: WifiOff,
    title: 'Pas de connexion Internet',
    body: 'Vérifie ta connexion réseau — la page se rechargera dès qu\'elle reviendra.',
  }
  if (reason.startsWith('gateway-')) {
    const code = reason.slice('gateway-'.length)
    return {
      icon: ServerOff,
      title: 'Serveur indisponible',
      body: `Le serveur a renvoyé une erreur ${code}. Il est probablement en train de redémarrer.`,
    }
  }
  if (reason.startsWith('ws-close-')) return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'La connexion temps-réel a été coupée. Le serveur est peut-être en train de redémarrer.',
  }
  if (reason === 'network') return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Impossible de joindre le serveur. Nouvelle tentative en cours.',
  }
  return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Nouvelle tentative de connexion en cours.',
  }
}

export default function ServerOfflineOverlay() {
  const [offline, setOffline] = useState(getIsOffline())
  const [reason, setReason] = useState(getReason())
  const [countdown, setCountdown] = useState(10)
  const [restartDetected, setRestartDetected] = useState(false)
  const pingingRef = useRef(false)
  const bundleCheckRef = useRef(false)

  useEffect(() => subscribe((isOffline) => {
    setOffline(isOffline)
    setReason(getReason())
  }), [])

  // Détection de redéploiement « à chaud » — quand le serveur redémarre assez
  // rapidement pour qu'aucune requête ne tombe (les nouvelles réponses
  // arrivent avec un nouveau X-Boot-Id). Sans ça, le client resterait
  // indéfiniment sur l'ancien bundle JS après un déploiement frontend.
  // Un pm2 restart sans rebuild client (cas fréquent) ne reload PAS : ça
  // fermerait toute modale ouverte et perdrait l'état de la page.
  useEffect(() => subscribeServerRestart((newBootId) => {
    if (bundleCheckRef.current) return // check déjà en cours
    bundleCheckRef.current = true
    resolveBundleState().then((state) => {
      if (state !== BUNDLE_CHANGED) {
        // Même bundle, ou impossible de savoir → accepter le nouveau boot_id
        // (sinon chaque réponse re-déclencherait ce handler) et rattraper les
        // données manquées, sans toucher à l'état de la page.
        acceptBootId(newBootId)
        sync()
        reconnectRealtime()
        return
      }
      setRestartDetected(true)
      // Laisse 1.2s pour que d'éventuelles requêtes en vol (autosave) puissent
      // finir et afficher l'overlay « Mise à jour » avant le reload.
      setTimeout(() => window.location.reload(), 1200)
    }).finally(() => { bundleCheckRef.current = false })
  }), [])

  useEffect(() => {
    if (!offline) return

    setCountdown(10)

    const tryPing = () => {
      if (pingingRef.current) return
      pingingRef.current = true
      fetch('/erp/api/health', { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) return
          const bootIdHeader = res.headers.get('X-Boot-Id')
          let bootId = bootIdHeader
          if (!bootId) {
            try { const j = await res.json(); bootId = j.boot_id } catch {}
          }
          const previous = getKnownBootId()
          const restarted = previous && bootId && previous !== bootId
          if (restarted) {
            // Serveur redémarré pendant l'outage. Reload uniquement si le
            // bundle client a changé (vrai déploiement frontend) — un pm2
            // restart sans rebuild garde le même bundle et un reload ne
            // ferait que fermer les modales ouvertes. Tant que `/erp/` répond
            // 502 (serveur encore en train de démarrer), on réessaie plutôt
            // que de conclure au déploiement.
            const state = await resolveBundleState()
            if (state === BUNDLE_CHANGED) {
              // setRestartDetected DOIT précéder markOnline — sinon offline=false
              // démonte le composant et l'écran "Mise à jour" ne s'affiche pas.
              setRestartDetected(true)
              setTimeout(() => { markOnline(); window.location.reload() }, 1200)
            } else {
              acceptBootId(bootId)
              markOnline()
              sync()
              reconnectRealtime()
            }
          } else {
            // Simple blip réseau (même serveur, même bundle) : masquer
            // l'overlay en place — surtout PAS de window.location.reload(),
            // qui fermerait les modales ouvertes et perdrait l'état de la
            // page. On rattrape les changements manqués via un delta
            // immédiat et on relance le WS sans attendre son backoff.
            markOnline()
            sync()
            reconnectRealtime()
          }
        })
        .catch(() => { /* still down — wait for next tick */ })
        .finally(() => { pingingRef.current = false })
    }

    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c > 1) return c - 1
        tryPing()
        return 10
      })
    }, 1000)

    return () => clearInterval(tick)
  }, [offline])

  if (!offline && !restartDetected) return null

  if (restartDetected) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <RefreshCw size={26} className="text-emerald-600 animate-spin" style={{ animationDuration: '1.6s' }} />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            Mise à jour de l'app en cours
          </h2>
          <p className="text-sm text-slate-600">
            Une nouvelle version vient d'être déployée. Rechargement…
          </p>
        </div>
      </div>
    )
  }

  const { icon: Icon, title, body } = describeReason(reason)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center">
        <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <Icon size={26} className="text-slate-600" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">
          {title}
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          {body}
        </p>
        <div className="flex items-center justify-center gap-2 text-sm text-slate-700">
          <Loader2 size={16} className="animate-spin text-slate-500" />
          <span>Nouvelle tentative dans <span className="font-semibold tabular-nums">{countdown}</span>&nbsp;s</span>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 text-xs text-slate-500 hover:text-slate-900 underline underline-offset-2"
        >
          Réessayer maintenant
        </button>
      </div>
    </div>
  )
}
