import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}


const STATUS_COLORS = {
  'Payé': 'green',
  'Payée': 'green',
  'À payer': 'yellow',
  'Partielle': 'yellow',
  'En retard': 'red',
  'Envoyée': 'blue',
  'Draft': 'gray',
  'Brouillon': 'gray',
  'Annulée': 'red',
  'Void': 'gray',
  'Supprimé': 'gray',
  'Note de crédit': 'purple',
  'Remboursement': 'purple',
  'Uncollectible': 'red',
}

const RENDERS = {
  document_number: row => <span className="font-mono font-medium text-slate-900">{row.document_number || '—'}</span>,
  company_name:    row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  project_name:    row => <span className="text-slate-600">{row.project_name || '—'}</span>,
  order_number:    row => row.order_id && row.order_number
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">#{row.order_number}</Link>
    : <span className="text-slate-400">—</span>,
  status:          row => row.status
    ? <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  document_date:   row => <span className="text-slate-500">{fmtDate(row.document_date)}</span>,
  due_date:        row => <span className="text-slate-500">{fmtDate(row.due_date)}</span>,
  invoice_id:      row => row.invoice_id
    ? <span className="font-mono text-xs text-slate-500">{row.invoice_id}</span>
    : <span className="text-slate-400">—</span>,
  currency:        row => row.currency
    ? <span className="font-mono text-xs text-slate-600">{row.currency}</span>
    : <span className="text-slate-400">—</span>,
  amount_before_tax_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.amount_before_tax_cad)}</span>,
  total_amount:    row => <span className="font-medium text-slate-700">{fmtCad(row.total_amount)}</span>,
  balance_due:     row => {
    const val = row.balance_due
    if (!val && val !== 0) return <span className="text-slate-400">—</span>
    return <span className={`font-medium ${val > 0 ? 'text-red-600' : 'text-green-600'}`}>{fmtCad(val)}</span>
  },
  is_sent:         row => (
    <span className={row.is_sent ? 'text-slate-700' : 'text-slate-400'}>
      {row.is_sent ? 'Oui' : 'Non'}
    </span>
  ),
  deferred_revenue_state: row => {
    const v = row.deferred_revenue_state
    if (v === 'Constaté') return <Badge color="green">Constaté</Badge>
    if (v === 'En attente') return <Badge color="yellow">En attente</Badge>
    return <span className="text-slate-300">—</span>
  },
}

const COLUMNS = TABLE_COLUMN_META.factures.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export default function Factures() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // Drilldown depuis le dashboard « Encaissements Stripe » :
  //   month=YYYY-MM filtre sur le mois de document_date (date de facturation)
  //   type=service|achat filtre sur la présence d'un abonnement lié
  // Côté Stripe uniquement : on ne montre que les factures sync_source='Factures Stripe'
  // au statut payé pour rester cohérent avec le widget dashboard.
  const month = searchParams.get('month')
  const typeFilter = searchParams.get('type') // 'service' | 'achat' | null

  const [factures, setFactures] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.factures.list({ limit, page }),
      setFactures, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  const displayedFactures = useMemo(() => {
    if (!month && !typeFilter) return factures
    return factures.filter(f => {
      if (month) {
        if (!f.document_date || !f.document_date.startsWith(month)) return false
        // Cohérent avec le widget « Ventes et abonnements » : factures Stripe
        // payées + remboursements Stripe du même mois (peu importe leur type
        // exact, l'utilisateur veut voir les déductions à côté des ventes).
        const isPaidSale = f.sync_source === 'Factures Stripe' && f.status === 'Payé'
        const isRefund = f.sync_source === 'Remboursements Stripe'
        if (!isPaidSale && !isRefund) return false
        // Le filtre par type ne s'applique qu'aux ventes — les remboursements
        // restent visibles indépendamment puisqu'on ne peut pas les classer
        // côté client (la classification se fait au backend).
        if (isPaidSale) {
          if (typeFilter === 'service' && !f.subscription_id) return false
          if (typeFilter === 'achat' && f.subscription_id) return false
        }
        return true
      }
      if (typeFilter === 'service' && !f.subscription_id) return false
      if (typeFilter === 'achat' && f.subscription_id) return false
      return true
    })
  }, [factures, month, typeFilter])

  const filterLabel = (() => {
    if (!month && !typeFilter) return null
    const parts = []
    if (month) {
      const [y, mo] = month.split('-')
      const d = new Date(Number(y), Number(mo) - 1, 1)
      parts.push(`facturées en ${d.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}`)
    }
    if (typeFilter === 'service') parts.push('abonnement')
    else if (typeFilter === 'achat') parts.push('vente')
    return parts.join(' · ')
  })()

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Factures clients</h1>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="factures" />
          </div>
        </div>

        {filterLabel && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg w-fit">
            <span className="text-sm text-brand-700 font-medium">Ventes &amp; abonnements — {filterLabel}</span>
            <span className="text-xs text-brand-400">{displayedFactures.length} facture{displayedFactures.length !== 1 ? 's' : ''}</span>
            <button
              onClick={() => setSearchParams({})}
              className="text-brand-400 hover:text-brand-700 ml-1"
              title="Effacer le filtre"
              aria-label="Effacer le filtre"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <DataTable
          table="factures"
          columns={COLUMNS}
          data={displayedFactures}
          searchFields={['document_number', 'company_name', 'project_name', 'order_number']}
          loading={loading}
          onRowClick={row => navigate(`/factures/${row.id}`)}
        />
      </div>
    </Layout>
  )
}
