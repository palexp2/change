import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Plus, X, Truck } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'


const RENDERS = {
  order_number: row => row.order_id
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-medium">#{row.order_number}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  tracking_number: row => <span className="font-mono text-xs text-slate-700">{row.tracking_number || '—'}</span>,
  carrier: row => <span className="text-slate-700">{row.carrier || '—'}</span>,
  pays: row => <span className="text-slate-700">{row.pays || '—'}</span>,
  shipped_at: row => <span className="text-slate-500">{fmtDate(row.shipped_at)}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.shipments.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function fmtAdresse(a) {
  return [a.line1, a.city, a.province, a.postal_code, a.country].filter(Boolean).join(', ')
}

function NewEnvoiModal({ orders, adresses, onSave, onClose }) {
  const [form, setForm] = useState({ order_id: '', tracking_number: '', carrier: '', pays: '', notes: '', address_id: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.order_id) { setError('Veuillez sélectionner une commande.'); return }
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Commande <span className="text-red-500">*</span></label>
        <SearchableSelect
          testId="envoi-order-select"
          className="select w-full"
          size="sm"
          value={form.order_id}
          onChange={v => setForm(f => ({ ...f, order_id: v }))}
          options={orders}
          getOptionValue={o => o.id}
          getOptionLabel={o => `#${o.order_number}${o.company_name ? ` — ${o.company_name}` : ''}`}
          placeholder="— Sélectionner —"
          searchPlaceholder="Rechercher une commande…"
        />
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
        <label className="label">Pays de l'envoi</label>
        <input
          type="text"
          value={form.pays}
          onChange={e => setForm(f => ({ ...f, pays: e.target.value }))}
          className="input"
          placeholder="ex. Canada, États-Unis, France…"
        />
      </div>
      <div>
        <label className="label">Adresse de livraison</label>
        <SearchableSelect
          testId="envoi-address-select"
          className="select w-full"
          size="sm"
          value={form.address_id}
          onChange={v => setForm(f => ({ ...f, address_id: v }))}
          options={adresses}
          getOptionValue={a => a.id}
          getOptionLabel={a => fmtAdresse(a)}
          placeholder="— Aucune —"
          emptyOption="— Aucune —"
          searchPlaceholder="Rechercher une adresse…"
        />
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

function parseWeekBounds(weekStr) {
  // weekStr = 'YYYY-MM-DD' (Monday of the week)
  if (!weekStr) return null
  const start = new Date(weekStr + 'T00:00:00')
  if (isNaN(start)) return null
  const end = new Date(start)
  end.setDate(start.getDate() + 7)
  return { start, end }
}

export default function Envois() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const weekFilter = searchParams.get('week') // 'YYYY-MM-DD' or null
  const weekBounds = parseWeekBounds(weekFilter)

  const [envois, setEnvois] = useState([])
  const [orders, setOrders] = useState([])
  const [adresses, setAdresses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.shipments.list({ limit, page }),
      setEnvois, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.orders.lookup().then(setOrders).catch(() => {})
    api.adresses.lookup().then(setAdresses).catch(() => {})
  }, [])

  useEntityListRealtime('shipment', setEnvois)

  async function handleCreate(form) {
    const envoi = await api.shipments.create(form)
    await load()
    navigate(`/envois/${envoi.id}`)
  }

  const displayedEnvois = weekBounds
    ? envois.filter(e => {
        const d = new Date(e.created_at)
        return d >= weekBounds.start && d < weekBounds.end
      })
    : envois

  const weekLabel = weekBounds
    ? weekBounds.start.toLocaleDateString('fr-CA', { month: 'long', day: 'numeric', year: 'numeric' })
    : null

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Envois</h1>
            <p className="text-sm text-slate-500 mt-0.5">{displayedEnvois.length} envoi{displayedEnvois.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvel envoi
            </button>
          </div>
        </div>

        {weekLabel && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg w-fit">
            <span className="text-sm text-brand-700 font-medium">Semaine du {weekLabel}</span>
            <button
              onClick={() => setSearchParams({})}
              className="text-brand-400 hover:text-brand-700 ml-1"
              title="Effacer le filtre"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <DataTable
          table="shipments"
          manageViews
          columns={COLUMNS}
          data={displayedEnvois}
          loading={loading}
          onRowClick={row => navigate(`/envois/${row.id}`)}
          searchFields={['order_number', 'tracking_number', 'company_name', 'carrier', 'pays']}
          emptyState={{ icon: Truck, title: 'Aucun envoi', description: "Aucune expédition n'a encore été créée. Crée un envoi pour générer une étiquette et suivre la livraison.", cta: { label: 'Nouvel envoi', icon: Plus, onClick: () => setShowModal(true) } }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvel envoi">
        <NewEnvoiModal orders={orders} adresses={adresses} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
