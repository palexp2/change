import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { CATEGORY_LABELS, CATEGORY_COLORS } from '../lib/subscriptionEvents.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { RachatPicker } from '../components/RachatPicker.jsx'

function fmtCad(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

export default function AbonnementMouvements() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedAbo, setSelectedAbo] = useState(null)
  const [loadingAboId, setLoadingAboId] = useState(null)

  async function openAbo(subscriptionId) {
    if (!subscriptionId || loadingAboId) return
    setLoadingAboId(subscriptionId)
    try {
      const sub = await api.abonnements.get(subscriptionId)
      setSelectedAbo(sub)
    } catch {
      // sub introuvable — silencieux côté UI
    } finally {
      setLoadingAboId(null)
    }
  }

  const RENDERS = {
    event_date: row => <span className="text-slate-500 whitespace-nowrap">{fmtDate(row.event_date)}</span>,
    category: row => row.category
      ? <Badge color={CATEGORY_COLORS[row.category] || 'gray'}>{CATEGORY_LABELS[row.category] || row.category}</Badge>
      : <span className="text-slate-400">—</span>,
    company_name: row => row.company_id
      ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name || '—'}</Link>
      : <span className="text-slate-400">—</span>,
    subscription_link: row => row.subscription_id
      ? (
        <button
          type="button"
          data-testid={`abo-event-open-${row.id}`}
          onClick={e => { e.stopPropagation(); openAbo(row.subscription_id) }}
          disabled={loadingAboId === row.subscription_id}
          className="text-brand-600 hover:underline font-mono text-xs disabled:opacity-50"
        >
          {row.stripe_subscription_id || row.subscription_id.slice(0, 8)}
        </button>
      )
      : <span className="text-slate-400">—</span>,
    amount_cad_delta: row => row.amount_cad_delta != null
      ? (
        <span className={`tabular-nums font-medium ${row.amount_cad_delta > 0 ? 'text-emerald-700' : row.amount_cad_delta < 0 ? 'text-rose-700' : 'text-slate-500'}`}>
          {row.amount_cad_delta > 0 ? '+' : ''}{fmtCad(row.amount_cad_delta)}
        </span>
      )
      : <span className="text-slate-400">—</span>,
    rachat: row => row.category === 'churn'
      ? <RachatPicker event={row} />
      : <span className="text-slate-300">—</span>,
    previous_amount_cad: row => <span className="tabular-nums text-slate-600">{fmtCad(row.previous_amount_cad)}</span>,
    new_amount_cad:      row => <span className="tabular-nums text-slate-600">{fmtCad(row.new_amount_cad)}</span>,
  }

  const COLUMNS = TABLE_COLUMN_META.abonnement_events.map(meta => ({
    ...meta,
    render: RENDERS[meta.id],
  }))

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.abonnements.events({ limit, page }),
      setEvents, setLoading,
    )
  }, [])

  useEffect(() => { load() }, [load])

  useRealtimeChannel('subscription_events:list', (msg) => {
    if (msg.type === 'subscription_event:created') {
      setEvents(prev => prev.some(e => e.id === msg.payload.id) ? prev : [msg.payload, ...prev])
    } else if (msg.type === 'subscription_event:updated') {
      setEvents(prev => prev.map(e => e.id === msg.payload.id ? { ...e, ...msg.payload } : e))
    } else if (msg.type === 'subscription_event:deleted') {
      setEvents(prev => prev.filter(e => e.id !== msg.payload.id))
    }
  })

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Mouvements d'abonnements</h1>
            <p className="text-sm text-slate-500 mt-1">
              Tous les évènements enregistrés : créations, mises à jour, annulations.
            </p>
          </div>
          <TableConfigModal table="abonnement_events" />
        </div>

        <DataTable
          table="abonnement_events"
          columns={COLUMNS}
          data={events}
          loading={loading}
          searchFields={['company_name', 'stripe_subscription_id']}
          onRowClick={row => openAbo(row.subscription_id)}
        />
      </div>

      <AbonnementDetailModal abonnement={selectedAbo} onClose={() => setSelectedAbo(null)} />
    </Layout>
  )
}
