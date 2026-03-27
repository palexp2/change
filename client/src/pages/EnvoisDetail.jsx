import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Pencil } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtCurrency(v) {
  if (v == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(v)
}

const STATUS_COLORS = { 'À envoyer': 'yellow', 'Envoyé': 'green' }

function fmtAdresse(addr) {
  return [addr.line1, addr.city, addr.province, addr.postal_code, addr.country]
    .filter(Boolean).join(', ')
}

function EditEnvoiModal({ envoi, adresses, onSave, onClose }) {
  const [form, setForm] = useState({
    tracking_number: envoi.tracking_number || '',
    carrier: envoi.carrier || '',
    status: envoi.status || 'À envoyer',
    shipped_at: envoi.shipped_at ? envoi.shipped_at.slice(0, 10) : '',
    notes: envoi.notes || '',
    address_id: envoi.address_id || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await onSave({
        ...form,
        shipped_at: form.shipped_at || null,
        tracking_number: form.tracking_number || null,
        carrier: form.carrier || null,
        notes: form.notes || null,
        address_id: form.address_id || null,
      })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Statut</label>
        <select
          value={form.status}
          onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
          className="select"
        >
          <option value="À envoyer">À envoyer</option>
          <option value="Envoyé">Envoyé</option>
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
        />
      </div>
      <div>
        <label className="label">Envoyé le</label>
        <input
          type="date"
          value={form.shipped_at}
          onChange={e => setForm(f => ({ ...f, shipped_at: e.target.value }))}
          className="input"
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
          {saving ? 'Enregistrement...' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}

export default function EnvoisDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [envoi, setEnvoi] = useState(null)
  const [adresses, setAdresses] = useState([])
  const [loading, setLoading] = useState(true)
  const [showEdit, setShowEdit] = useState(false)

  useEffect(() => {
    api.adresses.list({ limit: 'all' }).then(r => setAdresses(r.data)).catch(() => {})
  }, [])

  function load() {
    setLoading(true)
    api.shipments.get(id)
      .then(data => setEnvoi(data))
      .catch(() => setEnvoi(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  async function handleUpdate(form) {
    await api.shipments.update(id, form)
    load()
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!envoi) return <Layout><div className="p-6 text-slate-500">Envoi introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button
            onClick={() => navigate('/envois')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">
                {envoi.tracking_number ? `Envoi ${envoi.tracking_number}` : 'Envoi'}
              </h1>
              <Badge color={STATUS_COLORS[envoi.status] || 'gray'} size="md">{envoi.status}</Badge>
            </div>
            {envoi.company_name && envoi.company_id && (
              <div className="text-sm text-slate-500 mt-1">
                <Link to={`/companies/${envoi.company_id}`} className="text-indigo-600 hover:underline">
                  {envoi.company_name}
                </Link>
              </div>
            )}
          </div>
          <button onClick={() => setShowEdit(true)} className="btn-secondary flex items-center gap-1.5">
            <Pencil size={14} /> Modifier
          </button>
        </div>

        {/* Informations */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Commande</dt>
              <dd>
                {envoi.order_id
                  ? <Link to={`/orders/${envoi.order_id}`} className="text-indigo-600 hover:underline font-medium">#{envoi.order_number}</Link>
                  : <span className="text-slate-400">—</span>
                }
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Transporteur</dt>
              <dd className="text-slate-700">{envoi.carrier || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de suivi</dt>
              <dd className="font-mono text-slate-700">{envoi.tracking_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Envoyé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.shipped_at)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Créé le</dt>
              <dd className="text-slate-700">{fmtDate(envoi.created_at)}</dd>
            </div>
            {(envoi.address_line1 || envoi.address_city) && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Adresse de livraison</dt>
                <dd className="text-slate-700">
                  {[envoi.address_line1, envoi.address_city, envoi.address_province,
                    envoi.address_postal_code, envoi.address_country].filter(Boolean).join(', ')}
                </dd>
              </div>
            )}
            {envoi.notes && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                <dd className="text-slate-700 whitespace-pre-wrap">{envoi.notes}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Articles de la commande */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">
              Articles de la commande ({envoi.order_items?.length || 0})
            </h2>
          </div>
          {!envoi.order_items?.length ? (
            <p className="text-center py-10 text-slate-400">Aucun article sur cette commande</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">SKU</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Qté</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Coût unitaire</th>
                </tr>
              </thead>
              <tbody>
                {envoi.order_items.map((item, i) => (
                  <tr key={item.id || i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{item.product_name || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{item.sku || '—'}</td>
                    <td className="px-4 py-3 text-right text-slate-700">{item.qty ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-slate-500 hidden sm:table-cell">{fmtCurrency(item.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal isOpen={showEdit} onClose={() => setShowEdit(false)} title="Modifier l'envoi">
        <EditEnvoiModal envoi={envoi} adresses={adresses} onSave={handleUpdate} onClose={() => setShowEdit(false)} />
      </Modal>
    </Layout>
  )
}
