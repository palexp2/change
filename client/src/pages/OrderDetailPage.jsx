import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import RecordRevisionHistory from '../components/RecordRevisionHistory.jsx'
import api from '../lib/api.js'
import OrderDetail from './OrderDetail.jsx'

// Fiche commande en pleine page (route /orders/:id) : voir CompanyDetailPage.jsx.
export default function OrderDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [number, setNumber] = useState('')

  useEffect(() => {
    let cancelled = false
    setNumber('')
    api.orders.get(id).then(r => { if (!cancelled) setNumber(r?.order_number || '') }).catch(() => {})
    return () => { cancelled = true }
  }, [id])

  return (
    <Layout>
      <div className="flex items-center gap-3 px-5 pt-4">
        <button
          onClick={() => navigate('/orders')}
          className="p-1 -ml-1 text-slate-400 hover:text-slate-600 flex-shrink-0"
          aria-label="Retour aux commandes"
        >
          <ArrowLeft size={20} />
        </button>
        <PageTitle icon={null}>{number ? `Commande #${number}` : 'Commande'}</PageTitle>
      </div>
      <RecordScope id={id}>
        <OrderDetail recordId={id} onClose={() => navigate('/orders')} />
      </RecordScope>
      <RecordRevisionHistory table="orders" id={id} variant="page" />
    </Layout>
  )
}
