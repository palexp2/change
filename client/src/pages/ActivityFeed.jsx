import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Activity } from 'lucide-react'
import { api } from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'

// Mapping entity_type → fiche détail. Seules les entités qui possèdent une vraie
// page de détail (route /:id dans App.jsx) sont cliquables ; les autres restent
// du texte. Garder en phase avec les valeurs émises par emitEntity/emitOrder/
// emitCompany (server/src/services/realtimeEmitters.js).
const ENTITY_ROUTES = {
  order:        id => `/orders/${id}`,
  company:      id => `/companies/${id}`,
  contact:      id => `/contacts/${id}`,
  product:      id => `/products/${id}`,
  ticket:       id => `/tickets/${id}`,
  project:      id => `/projects/${id}`,
  soumission:   id => `/soumissions/${id}`,
  purchase:     id => `/purchases/${id}`,
  facture:      id => `/factures/${id}`,
  sale_receipt: id => `/sale-receipts/${id}`,
  employee:     id => `/employees/${id}`,
  shipment:     id => `/envois/${id}`,
}

// Libellés FR par type d'entité.
const ENTITY_LABELS = {
  order: 'Commande', company: 'Entreprise', contact: 'Contact',
  product: 'Produit', ticket: 'Billet', task: 'Tâche', project: 'Projet',
  interaction: 'Interaction', soumission: 'Soumission', call: 'Appel',
  purchase: 'Achat', facture: 'Facture', sale_receipt: 'Reçu de vente',
  timesheet: 'Feuille de temps', employee: 'Employé', paie: 'Paie',
  hour_bank_entry: "Banque d'heures", activity_code: "Code d'activité",
  shipment: 'Envoi', adresse: 'Adresse', vacation: 'Congé',
  achat_fournisseur: 'Achat fournisseur',
}

const ACTION_BADGES = {
  created: { label: 'Créé',     cls: 'text-green-700 bg-green-100' },
  updated: { label: 'Modifié',  cls: 'text-blue-700 bg-blue-100' },
  deleted: { label: 'Supprimé', cls: 'text-red-700 bg-red-100' },
}

const RENDERS = {
  created_at: row => <span className="text-slate-500 text-sm">{fmtDateTime(row.created_at)}</span>,
  user_name: row => row.user_name
    ? <span className="font-medium text-slate-800">{row.user_name}</span>
    : <span className="text-slate-400">Système</span>,
  action: row => {
    const b = ACTION_BADGES[row.action] || { label: row.action, cls: 'text-slate-600 bg-slate-100' }
    return <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${b.cls}`}>{b.label}</span>
  },
  entity_type: row => <span className="text-slate-600">{ENTITY_LABELS[row.entity_type] || row.entity_type}</span>,
  detail: row => {
    const text = row.detail || row.entity_id || '—'
    const routeFn = row.entity_id && row.action !== 'deleted' ? ENTITY_ROUTES[row.entity_type] : null
    if (routeFn) {
      return (
        <Link
          to={routeFn(row.entity_id)}
          onClick={e => e.stopPropagation()}
          className="text-brand-600 hover:text-brand-700 hover:underline font-medium"
        >
          {text}
        </Link>
      )
    }
    return <span className="text-slate-700">{text}</span>
  },
}

const COLUMNS = TABLE_COLUMN_META.activity_log.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

export function ActivityContent() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.activity.list({ limit, page }),
      setRows, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <PageTitle icon={Activity}>Feed des opérations</PageTitle>
          <p className="text-xs text-slate-400 mt-0.5">Qui a fait quoi, et quand</p>
        </div>
      </div>

      <DataTable
        table="activity_log"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={loading}
        searchFields={['user_name', 'entity_type', 'action', 'detail', 'entity_id']}
      />
    </div>
  )
}

export default function ActivityFeed() {
  return (
    <Layout>
      <div className="p-6">
        <ActivityContent />
      </div>
    </Layout>
  )
}
