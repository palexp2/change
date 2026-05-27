import { useEffect, useState, useRef } from 'react'
import { Loader2, ServerOff, RefreshCw, WifiOff } from 'lucide-react'
import { subscribe, getIsOffline, getReason, getKnownBootId, markOnline, subscribeServerRestart } from '../lib/serverStatus.js'

// Fullscreen overlay shown when the server is unreachable. Pings /api/health
// every 10 s; on success, compare the returned boot_id with the one we saw
// before the outage:
//   - boot_id changed → pm2 a redémarré (typiquement un déploiement) → message
//     "Mise à jour de l'app en cours" puis reload.
//   - boot_id identique ou inconnu → simple blip réseau → reload silencieux.
//
// L'apparition est debouncée 400 ms côté serverStatus.js — les blips < 400 ms
// (reconnexion WS, requête transiente) ne déclenchent jamais l'overlay.
//
// Triggered by lib/serverStatus → see realtime.js (WS abnormal close) and
// api.js (network error / 502 / 503 / 504).

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

  useEffect(() => subscribe((isOffline) => {
    setOffline(isOffline)
    setReason(getReason())
  }), [])

  // Détection de redéploiement « à chaud » — quand le serveur redémarre assez
  // rapidement pour qu'aucune requête ne tombe (les nouvelles réponses
  // arrivent avec un nouveau X-Boot-Id). Sans ça, le client reste indéfiniment
  // sur l'ancien bundle JS jusqu'à une vraie déconnexion réseau.
  useEffect(() => subscribeServerRestart(() => {
    setRestartDetected(true)
    // Laisse 1.2s pour que d'éventuelles requêtes en vol (autosave) puissent
    // finir et afficher l'overlay « Mise à jour » avant le reload.
    setTimeout(() => window.location.reload(), 1200)
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
            // setRestartDetected DOIT précéder markOnline — sinon offline=false
            // démonte le composant et l'écran "Mise à jour" ne s'affiche pas.
            setRestartDetected(true)
            setTimeout(() => { markOnline(); window.location.reload() }, 1200)
          } else {
            markOnline()
            window.location.reload()
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
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
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
