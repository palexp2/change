import { useState, useEffect, useCallback } from 'react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { AbonnementEventsTable } from '../components/AbonnementEventsTable.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'

export default function AbonnementMouvements() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

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

        <AbonnementEventsTable data={events} loading={loading} />
      </div>
    </Layout>
  )
}
