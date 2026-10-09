import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useAuth } from '../lib/auth.jsx'

// Avis animé quand le robot de rapprochement a fini — visible sur toutes les
// pages (Charles, 2026-10-06). Mois fermé : carte verte pour tous ; passage non
// terminé : carte ambre, seulement pour celui qui l'a lancé.
const monthName = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' }) : '')

export default function ReconcileNotifier() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const timers = useRef(new Map())
  const itemsRef = useRef(items)
  itemsRef.current = items

  const dismiss = (key) => {
    clearTimeout(timers.current.get(key))
    timers.current.delete(key)
    setItems((list) => list.filter((x) => x.key !== key))
  }
  // Disparition en fondu, puis retrait.
  const leave = (key) => {
    setItems((list) => list.map((x) => (x.key === key ? { ...x, leaving: true } : x)))
    timers.current.set(key, setTimeout(() => dismiss(key), 350))
  }
  // Le compte à rebours ne part que si l'onglet est affiché : un avis arrivé
  // pendant qu'on est ailleurs attend qu'on revienne sur Boréal, puis s'en va
  // seul une fois vu — alerte comprise, sans avoir à la fermer (Charles, 2026-10-06).
  const arm = (key) => {
    clearTimeout(timers.current.get(key))
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    setItems((list) => list.map((x) => (x.key === key && x.leaving ? { ...x, leaving: false } : x)))
    timers.current.set(key, setTimeout(() => leave(key), itemsRef.current.find((x) => x.key === key && !x.finished) ? 10000 : 6600))
  }
  // Survolée, la carte reste : le temps de sélectionner et copier son texte.
  const hold = (key) => clearTimeout(timers.current.get(key))

  useRealtimeChannel('bank:reconcile', (msg) => {
    const p = msg.payload
    if (!p || (!p.finished && p.run_by !== user?.id)) return
    const key = `${p.account_id}-${Date.now()}`
    const item = { ...p, key }
    itemsRef.current = [...itemsRef.current, item]
    setItems((list) => [...list, item])
    arm(key)
  })

  useEffect(() => {
    // Retour sur l'onglet ou sur la fenêtre : le compte à rebours part maintenant.
    const onVisible = () => itemsRef.current.forEach((x) => arm(x.key))
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Un clic ouvre le compte, sauf s'il termine une sélection de texte.
  const open = (it) => {
    if (String(window.getSelection?.() || '').trim()) return
    navigate(`/rapprochement-qbo?compte=${it.account_id}`)
    dismiss(it.key)
  }

  if (!items.length) return null
  return (
    <div className="fixed right-5 bottom-5 z-[9998] flex flex-col gap-2">
      {items.map((it) => (
        <div key={it.key} role="button" tabIndex={0} onClick={() => open(it)}
          onKeyDown={(e) => { if (e.key === 'Enter') open(it) }}
          onMouseEnter={() => hold(it.key)} onMouseLeave={() => arm(it.key)}
          className={`reconcile-toast select-text cursor-text ${it.finished ? 'is-done' : 'is-warn'}${it.leaving ? ' is-leaving' : ''}`} data-testid="reconcile-toast">
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <circle cx="12" cy="12" r="11" fill={it.finished ? '#2ca01c' : '#d97706'} />
            {it.finished
              ? <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M12 7v6M12 16.5v.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />}
          </svg>
          <span className="text-left">
            <span className="block font-semibold">{it.account_name} · {monthName(it.statement_date)}</span>
            <span className="block text-xs opacity-75">{it.finished ? 'Rapproché et fermé ✓' : (it.note || 'Non terminé')}</span>
          </span>
          <button type="button" aria-label="Fermer" onClick={(e) => { e.stopPropagation(); dismiss(it.key) }}
            className="ml-1 self-start opacity-50 hover:opacity-100 leading-none">×</button>
        </div>
      ))}
    </div>
  )
}
