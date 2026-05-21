import { useEffect, useState, useRef } from 'react'
import { Loader2, ServerOff } from 'lucide-react'
import { subscribe, getIsOffline, markOnline } from '../lib/serverStatus.js'

// Fullscreen overlay shown when the server is unreachable (typically during a
// pm2 restart). Counts down 10 s, then pings /erp/api/auth/me; on success,
// reloads the page so the UI gets a fresh state instead of half-loaded data.
//
// Triggered by lib/serverStatus → see realtime.js (WS abnormal close) and
// api.js (network error / 502 / 503 / 504).
export default function ServerOfflineOverlay() {
  const [offline, setOffline] = useState(getIsOffline())
  const [countdown, setCountdown] = useState(10)
  const pingingRef = useRef(false)

  useEffect(() => subscribe(setOffline), [])

  useEffect(() => {
    if (!offline) return

    setCountdown(10)

    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c > 1) return c - 1
        // Hit 0 — attempt a ping. Don't overlap if a previous one is in flight.
        if (!pingingRef.current) {
          pingingRef.current = true
          const token = localStorage.getItem('erp_token')
          fetch('/erp/api/auth/me', {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            cache: 'no-store',
          })
            .then((res) => {
              if (res.status === 502 || res.status === 503 || res.status === 504) return
              // Server responded — reload to get a clean state. markOnline()
              // is mostly cosmetic since we're about to reload.
              markOnline()
              window.location.reload()
            })
            .catch(() => { /* still down — wait for next tick */ })
            .finally(() => { pingingRef.current = false })
        }
        return 10
      })
    }, 1000)

    return () => clearInterval(tick)
  }, [offline])

  if (!offline) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center">
        <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <ServerOff size={26} className="text-slate-600" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">
          Connexion au serveur perdue
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          Le serveur est probablement en train de redémarrer. La page se rechargera automatiquement dès qu'il sera de nouveau disponible.
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
