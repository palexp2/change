import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { AbonnementEventsTable } from '../components/AbonnementEventsTable.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'

export default function AbonnementMouvements() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  // Filtre temporaire posé par un clic sur une barre du graphique « Delta MRR
  // net » (vue globale du dashboard) : 'YYYY-MM'.
  const monthFilter = searchParams.get('month')

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

  // Même bucketing que le graphique du dashboard : mois de `event_date`.
  const displayedEvents = useMemo(() => {
    if (!monthFilter) return events
    return events.filter(e => String(e.month || e.event_date || '').slice(0, 7) === monthFilter)
  }, [events, monthFilter])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <PageTitle>Mouvements d'abonnements</PageTitle>
            <p className="text-sm text-slate-500 mt-1">
              Tous les évènements enregistrés : créations, mises à jour, annulations.
            </p>
          </div>
        </div>

        {monthFilter && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700" data-testid="abo-events-month-filter">
            <span>
              Mouvements de {new Date(`${monthFilter}-15T12:00:00Z`).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
              {' '}({displayedEvents.length})
            </span>
            <button
              onClick={() => setSearchParams({})}
              className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700"
              data-testid="abo-events-month-clear"
            >
              <X size={13} /> Effacer
            </button>
          </div>
        )}

        <AbonnementEventsTable data={displayedEvents} loading={loading} manageViews forceAllView={!!monthFilter} />
      </div>
    </Layout>
  )
}
