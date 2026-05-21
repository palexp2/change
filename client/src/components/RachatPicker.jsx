// Picker pour le statut de "rachat" sur un event de churn d'abonnement.
//
// Affiche un badge cliquable :
//   - rachat_status NULL    → badge gris "Vérifier" (peu visible mais cliquable)
//   - 'probable'           → badge jaune "Rachat probable" + lien commande
//   - 'confirmed'          → badge vert "Rachat confirmé" + lien commande
//   - 'none'               → badge gris "Pas de rachat"
//
// Au clic, ouvre un menu dropdown qui permet de basculer entre les statuts.
// Autosave instant (PATCH /api/projets/abonnement-events/:id/rachat).
//
// Intégré dans la page AbonnementMouvements (colonne "Rachat") et la modale
// AbonnementDetailModal pour les events de churn.

import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { Badge } from './Badge.jsx'
import { RACHAT_LABELS, RACHAT_COLORS } from '../lib/subscriptionEvents.js'

export function RachatPicker({ event }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // Optimistic local copy : permet d'afficher le nouveau statut tout de suite
  // sans attendre la prop event re-rendue par le realtime channel.
  const [local, setLocal] = useState({
    rachat_status: event.rachat_status,
    rachat_order_id: event.rachat_order_id,
    rachat_order_number: event.rachat_order_number,
  })
  const ref = useRef(null)

  useEffect(() => {
    setLocal({
      rachat_status: event.rachat_status,
      rachat_order_id: event.rachat_order_id,
      rachat_order_number: event.rachat_order_number,
    })
  }, [event.rachat_status, event.rachat_order_id, event.rachat_order_number])

  useEffect(() => {
    if (!open) return
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  async function setStatus(status) {
    setSaving(true)
    setOpen(false)
    setLocal(l => ({ ...l, rachat_status: status }))
    try {
      await api.abonnements.eventRachatPatch(event.id, { status })
    } catch (e) {
      // Rollback optimistic update sur erreur
      setLocal({
        rachat_status: event.rachat_status,
        rachat_order_id: event.rachat_order_id,
        rachat_order_number: event.rachat_order_number,
      })
      console.error('Rachat patch failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const status = local.rachat_status
  const label = status ? RACHAT_LABELS[status] : 'Vérifier'
  const color = status ? RACHAT_COLORS[status] : 'gray'

  return (
    <div className="relative inline-flex items-center gap-2" ref={ref} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        data-testid={`rachat-picker-${event.id}`}
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        className="cursor-pointer disabled:opacity-50"
        title="Modifier le statut de rachat"
      >
        <Badge color={color}>{label}</Badge>
      </button>
      {local.rachat_order_id && local.rachat_order_number && (status === 'probable' || status === 'confirmed') && (
        <Link
          to={`/orders/${local.rachat_order_id}`}
          onClick={e => e.stopPropagation()}
          data-testid={`rachat-order-link-${event.id}`}
          className="text-xs text-brand-600 hover:underline tabular-nums"
        >
          #{local.rachat_order_number}
        </Link>
      )}
      {open && (
        <div
          className="absolute z-50 mt-1 top-full left-0 bg-white border border-slate-200 rounded-md shadow-lg py-1 min-w-[180px]"
          data-testid={`rachat-picker-menu-${event.id}`}
        >
          {[
            { v: 'probable',  label: 'Rachat probable' },
            { v: 'confirmed', label: 'Rachat confirmé' },
            { v: 'merged',    label: 'Fusionné' },
            { v: 'none',      label: 'Pas de rachat' },
            { v: null,        label: 'Non vérifié' },
          ].map(opt => (
            <button
              key={String(opt.v)}
              type="button"
              data-testid={`rachat-option-${event.id}-${opt.v ?? 'null'}`}
              onClick={() => setStatus(opt.v)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ${status === opt.v ? 'font-semibold text-brand-700' : 'text-slate-700'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
