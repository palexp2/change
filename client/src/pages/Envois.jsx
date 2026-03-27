import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUS_COLORS = { 'À envoyer': 'yellow', 'Envoyé': 'green' }

const RENDERS = {
  order_number: row => row.order_id
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline font-medium">#{row.order_number}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  tracking_number: row => <span className="font-mono text-xs text-slate-700">{row.tracking_number || '—'}</span>,
  carrier: row => <span className="text-slate-700">{row.carrier || '—'}</span>,
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  shipped_at: row => <span className="text-slate-500">{fmtDate(row.shipped_at)}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.shipments.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function fmtAdresse(a) {
  return [a.line1, a.city, a.province, a.postal_code, a.country].filter(Boolean).join(', ')
}

function NewEnvoiModal({ orders, adresses, onSave, onClose }) {
  const [form, setForm] = useState({ order_id: '', tracking_number: '', carrier: '', notes: '', address_id: '' })
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
        <label className="label">Commande <span className="text-red-500">*</span></label>
        <select
          value={form.order_id}
          onChange={e => setForm(f => ({ ...f, order_id: e.target.value }))}
          className="select"
          required
        >
          <option value="">— Sélectionner —</option>
          {orders.map(o => (
            <option key={o.id} value={o.id}>
              #{o.order_number}{o.company_name ? ` — ${o.company_name}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Transporteur</label>
        <input
          type="text"
          value={form.carrier}
          onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))}
          className="input"
          placeholder="ex. Purolator, FedEx, UPS…"
        />
      </div>
      <div>
        <label className="label">N° de suivi</label>
        <input
          type="text"
          value={form.tracking_number}
          onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))}
          className="input"
          placeholder="ex. 1Z999AA10123456784"
        />
      </div>
      <div>
        <label className="label">Adresse de livraison</label>
        <select
          value={form.address_id}
          onChange={e => setForm(f => ({ ...f, address_id: e.target.value }))}
          className="select"
        >
          <option value="">— Aucune —</option>
          {adresses.map(a => (
            <option key={a.id} value={a.id}>{fmtAdresse(a)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          className="input"
          rows={3}
        />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Création...' : 'Créer l\'envoi'}
        </button>
      </div>
    </form>
  )
}

export default function Envois() {
  const navigate = useNavigate()
  const [envois, setEnvois] = useState([])
  const [orders, setOrders] = useState([])
  const [adresses, setAdresses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.shipments.list({ limit: 'all' })
      setEnvois(res.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.orders.list({ limit: 'all' }).then(r => setOrders(r.data)).catch(() => {})
    api.adresses.list({ limit: 'all' }).then(r => setAdresses(r.data)).catch(() => {})
  }, [])

  async function handleCreate(form) {
    const envoi = await api.shipments.create(form)
    await load()
    navigate(`/envois/${envoi.id}`)
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Envois</h1>
            <p className="text-sm text-slate-500 mt-0.5">{envois.length} envoi{envois.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="shipments" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvel envoi
            </button>
          </div>
        </div>

        <DataTable
          table="shipments"
          columns={COLUMNS}
          data={envois}
          loading={loading}
          onRowClick={row => navigate(`/envois/${row.id}`)}
          searchFields={['order_number', 'tracking_number', 'company_name', 'carrier']}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvel envoi">
        <NewEnvoiModal orders={orders} adresses={adresses} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
