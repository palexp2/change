import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const RENDERS = {
  order_number: row => <span className="font-bold text-slate-900">#{row.order_number}</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline font-medium">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  status: row => <Badge color={orderStatusColor(row.status)}>{row.status}</Badge>,
  priority: row => row.priority
    ? <span className="text-orange-500 font-medium text-xs">{row.priority}</span>
    : <span className="text-slate-400">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.orders.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function NewOrderModal({ companies, users, onSave, onClose }) {
  const [form, setForm] = useState({ company_id: '', assigned_to: '', priority: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Entreprise</label>
        <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))} className="select">
          <option value="">— Sélectionner —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Assigné à</label>
        <select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))} className="select">
          <option value="">— Non assigné —</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Priorité</label>
        <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className="select">
          <option value="">— Normale —</option>
          <option value="Urgent">Urgent</option>
          <option value="Haute">Haute</option>
          <option value="Basse">Basse</option>
        </select>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={3} />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Création...' : 'Créer la commande'}</button>
      </div>
    </form>
  )
}

export default function Orders() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState([])
  const [companies, setCompanies] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.orders.list({ limit: 'all' })
      setOrders(res.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.list({ limit: 'all' }).then(r => setCompanies(r.data)).catch(() => {})
    api.admin.listUsers().then(setUsers).catch(() => {})
  }, [])

  async function handleCreate(form) {
    const order = await api.orders.create(form)
    navigate(`/orders/${order.id}`)
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Commandes</h1>
            <p className="text-slate-500 text-sm mt-1">{orders.length} commandes</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="orders" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvelle commande
            </button>
          </div>
        </div>

        <DataTable
          table="orders"
          columns={COLUMNS}
          data={orders}
          loading={loading}
          onRowClick={row => navigate(`/orders/${row.id}`)}
          searchFields={['order_number', 'company_name']}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvelle commande">
        <NewOrderModal companies={companies} users={users} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
