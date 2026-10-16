import { useState, useEffect } from 'react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { DashboardOverview } from '../components/DashboardOverview.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'

// Le tableau de bord n'a plus qu'une lecture : la planche dense « Vue globale ».
// La vue par sections (dépliables, ordonnables, masquables) a été retirée ;
// /dashboard/:section reste routé pour que les anciens liens tombent ici.
export default function Dashboard() {
  const [data, setData] = useState(null)
  const [subscriptionEvents, setSubscriptionEvents] = useState(null)

  useEffect(() => {
    api.dashboard.get().then(setData).catch(console.error)
    api.dashboard.subscriptionEvents({ months: 12 }).then(setSubscriptionEvents).catch(console.error)
  }, [])

  // Entreprise d'un mouvement corrigée (fiche abonnement, collègue) → planche.
  useRealtimeChannel('subscription_events:list', (msg) => {
    if (msg.type !== 'subscription_event:updated') return
    const { id, company_id, company_name } = msg.payload
    setSubscriptionEvents(prev => prev && {
      ...prev,
      months: prev.months.map(m => ({
        ...m,
        categories: Object.fromEntries(Object.entries(m.categories).map(([cat, c]) => [cat, {
          ...c,
          items: c.items?.map(it => it.event_id === id ? { ...it, company_id, company_name } : it),
        }])),
      })),
    })
  })

  if (!data) {
    return (
      <Layout>
        <Spinner center />
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="p-6 mx-auto max-w-[1700px]">
        <div className="mb-4">
          <PageTitle>Tableau de bord</PageTitle>
        </div>
        <DashboardOverview data={data} subscriptionEvents={subscriptionEvents} />
      </div>
    </Layout>
  )
}
