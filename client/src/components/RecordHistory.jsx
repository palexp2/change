// Panneau « Historique » réutilisable par enregistrement.
//
// Affiche la timeline « qui a fait quoi, quand » d'un record, alimentée par
// GET /api/records/:table/:id/history (activity_log + change_log côté serveur).
// Calqué sur le HistoryTab de SaleReceiptDetail, mais générique : n'importe
// quelle fiche détail le branche avec sa table et l'id du record.
//
// Usage :
//   <RecordHistory table="companies" id={company.id} />
//
// Le chargement est paresseux : passer `active={false}` (ex. onglet fermé)
// diffère le fetch jusqu'à ce que le panneau soit réellement affiché.

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Clock, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'

const ACTION_META = {
  created:  { label: 'Créé',      Icon: Plus,      color: 'text-green-700 bg-green-100' },
  create:   { label: 'Créé',      Icon: Plus,      color: 'text-green-700 bg-green-100' },
  updated:  { label: 'Modifié',   Icon: Pencil,    color: 'text-blue-700 bg-blue-100' },
  update:   { label: 'Modifié',   Icon: Pencil,    color: 'text-blue-700 bg-blue-100' },
  deleted:  { label: 'Supprimé',  Icon: Trash2,    color: 'text-red-700 bg-red-100' },
  delete:   { label: 'Supprimé',  Icon: Trash2,    color: 'text-red-700 bg-red-100' },
}

export default function RecordHistory({ table, id, active = true }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!active || !table || !id) return
    let cancelled = false
    setEvents(null)
    setError(false)
    api.records.history(table, id)
      .then(r => { if (!cancelled) setEvents(r.data || []) })
      .catch(() => { if (!cancelled) { setEvents([]); setError(true) } })
    return () => { cancelled = true }
  }, [table, id, active])

  if (!active) return null
  if (events === null) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-loading">Chargement de l'historique…</div>
  }
  if (error) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-error">Impossible de charger l'historique.</div>
  }
  if (events.length === 0) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-empty">Aucun historique.</div>
  }

  return (
    <ol className="relative border-l border-slate-200 ml-3" data-testid="record-history">
      {events.map(ev => {
        const meta = ACTION_META[ev.action] || { label: ev.action, Icon: Clock, color: 'text-slate-600 bg-slate-100' }
        const { Icon } = meta
        const isSystem = ev.source === 'system'
        // « Modifié » sans acteur humain = sync externe (Airtable/Stripe/Gmail) ;
        // on le signale avec une icône dédiée pour distinguer du système.
        const ShownIcon = isSystem && (ev.action === 'updated' || ev.action === 'update') ? RefreshCw : Icon
        const actor = ev.user_name || (isSystem ? 'Synchronisation / système' : 'Utilisateur inconnu')
        return (
          <li key={ev.id} className="mb-6 ml-6" data-testid="record-history-event">
            <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${meta.color}`}>
              <ShownIcon size={12} />
            </span>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-slate-800">
                {meta.label}
                {ev.detail && <span className="text-slate-500"> — {ev.detail}</span>}
              </p>
              <span className="text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(ev.created_at)}</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5" data-testid="record-history-actor">par {actor}</p>
          </li>
        )
      })}
    </ol>
  )
}
