import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus, Truck, Package, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { Modal, ConfirmModal } from '../components/Modal.jsx'

function trackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null
  const c = (carrier || '').toLowerCase()
  if (c.includes('purolator')) return `https://www.purolator.com/en/ship-track/tracking-summary.page?pin=${trackingNumber}`
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${trackingNumber}`
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`
  if (c.includes('postes canada') || c.includes('canada post') || c.includes('cp')) return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${trackingNumber}`
  if (c.includes('dicom')) return `https://www.dicom.com/en/tracking?trackingNumber=${trackingNumber}`
  if (c.includes('gls')) return `https://gls-group.com/track/${trackingNumber}`
  if (c.includes('canpar')) return `https://www.canpar.com/en/parcelTracking/searchByPin.do?pin=${trackingNumber}`
  return null
}

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

const ITEM_TYPES = ['Facturable', 'Remplacement', 'Non facturable']
const ITEM_TYPE_COLORS = { 'Facturable': 'green', 'Remplacement': 'yellow', 'Non facturable': 'gray' }

function AddItemModal({ orderId, onSave, onClose }) {
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ product_id: '', qty: 1, unit_cost: '', item_type: 'Facturable', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.products.list({ limit: 200, active: true }).then(r => setProducts(r.data)).catch(() => {})
  }, [])

  function handleProductChange(e) {
    const product = products.find(p => p.id === e.target.value)
    setForm(f => ({ ...f, product_id: e.target.value, unit_cost: product?.unit_cost || '' }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.orders.addItem(orderId, { ...form, qty: parseInt(form.qty), unit_cost: parseFloat(form.unit_cost) || 0 })
      onSave()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Produit</label>
        <select value={form.product_id} onChange={handleProductChange} className="select">
          <option value="">— Sélectionner —</option>
          {products.map(p => (
            <option key={p.id} value={p.id}>{p.name_fr} {p.sku ? `(${p.sku})` : ''}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Quantité *</label>
          <input type="number" min="1" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Coût unitaire</label>
          <input type="number" min="0" step="0.01" value={form.unit_cost} onChange={e => setForm(f => ({ ...f, unit_cost: e.target.value }))} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Type</label>
        <select value={form.item_type} onChange={e => setForm(f => ({ ...f, item_type: e.target.value }))} className="select">
          {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Notes</label>
        <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? '...' : 'Ajouter'}</button>
      </div>
    </form>
  )
}

function AddShipmentModal({ orderId, onSave, onClose }) {
  const [form, setForm] = useState({ tracking_number: '', carrier: '', status: 'À envoyer', shipped_at: '', notes: '' })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.orders.addShipment(orderId, form)
      onSave()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Transporteur</label>
          <input value={form.carrier} onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))} className="input" placeholder="Purolator, FedEx..." />
        </div>
        <div>
          <label className="label">N° de suivi</label>
          <input value={form.tracking_number} onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="select">
            <option value="À envoyer">À envoyer</option>
            <option value="Envoyé">Envoyé</option>
          </select>
        </div>
        <div>
          <label className="label">Date d'envoi</label>
          <input type="date" value={form.shipped_at} onChange={e => setForm(f => ({ ...f, shipped_at: e.target.value }))} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={2} />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? '...' : 'Ajouter'}</button>
      </div>
    </form>
  )
}

export default function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showAddItem, setShowAddItem] = useState(false)
  const [showAddShipment, setShowAddShipment] = useState(false)
  const [deleteItem, setDeleteItem] = useState(null)


  async function load() {
    setLoading(true)
    try {
      const data = await api.orders.get(id)
      setOrder(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function handleDeleteItem(itemId) {
    await api.orders.deleteItem(id, itemId)
    load()
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!order) return <Layout><div className="p-6 text-slate-500">Commande introuvable.</div></Layout>

  const totalValue = order.items?.reduce((s, i) => s + (i.qty * i.unit_cost), 0) || 0
  const billableValue = order.items?.filter(i => i.item_type === 'Facturable').reduce((s, i) => s + (i.qty * i.unit_cost), 0) || 0

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/orders')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">Commande #{order.order_number}</h1>
              <Badge color={orderStatusColor(order.status)} size="md">{order.status}</Badge>
              {order.priority && <Badge color="orange">{order.priority}</Badge>}
            </div>
            <div className="text-sm text-slate-500 mt-1">
              {order.company_name && (
                <Link to={`/companies/${order.company_id}`} className="text-indigo-600 hover:underline mr-2">
                  {order.company_name}
                </Link>
              )}
              · Créée le {fmtDate(order.created_at)}
              {order.assigned_name && ` · ${order.assigned_name}`}
            </div>
          </div>

        </div>

        {/* Items section */}
        <div className="card mb-4">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Articles ({order.items?.length || 0})</h2>
            <button onClick={() => setShowAddItem(true)} className="btn-primary btn-sm"><Plus size={14} /> Ajouter</button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500">Produit</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500">Qté</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Coût unit.</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Total</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Type</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {order.items?.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-slate-400">
                  <Package size={24} className="mx-auto mb-2 text-slate-300" />
                  Aucun article — cliquez "Ajouter" pour commencer
                </td></tr>
              ) : order.items?.map(item => (
                <>
                  <tr key={item.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-900">{item.product_name || 'Produit inconnu'}</div>
                      {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
                      {item.notes && <div className="text-xs text-slate-500 italic mt-0.5">{item.notes}</div>}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-slate-900">{item.qty}</td>
                    <td className="px-4 py-3 text-right hidden md:table-cell text-slate-500">{fmtCad(item.unit_cost)}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">{fmtCad(item.qty * item.unit_cost)}</td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <Badge color={ITEM_TYPE_COLORS[item.item_type] || 'gray'}>{item.item_type}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => setDeleteItem(item)} className="text-slate-400 hover:text-red-500 p-1 rounded transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                  {item.serials?.length > 0 && (
                    <tr key={`${item.id}-serials`} className="border-b border-slate-100 bg-slate-50/50">
                      <td colSpan={6} className="px-5 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {item.serials.map(s => (
                            <span key={s.id} className="inline-flex items-center gap-1 text-xs font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded border border-slate-200">
                              {s.serial}
                              {s.status && <span className="text-slate-400">· {s.status}</span>}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
            {order.items?.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={3} className="px-5 py-3 text-sm font-semibold text-slate-600">Total facturable</td>
                  <td className="px-4 py-3 text-right font-bold text-indigo-600">{fmtCad(billableValue)}</td>
                  <td colSpan={2}></td>
                </tr>
                {totalValue !== billableValue && (
                  <tr>
                    <td colSpan={3} className="px-5 py-2 text-xs text-slate-400">Total tous articles</td>
                    <td className="px-4 py-2 text-right text-xs text-slate-400">{fmtCad(totalValue)}</td>
                    <td colSpan={2}></td>
                  </tr>
                )}
              </tfoot>
            )}
          </table>
        </div>

        {/* Shipments section */}
        <div className="card mb-4">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Expéditions ({order.shipments?.length || 0})</h2>
            <button onClick={() => setShowAddShipment(true)} className="btn-secondary btn-sm"><Plus size={14} /> Ajouter</button>
          </div>
          {order.shipments?.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <Truck size={24} className="mx-auto mb-2 text-slate-300" />
              Aucune expédition
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500">Transporteur</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">N° suivi</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Statut</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Date envoi</th>
                </tr>
              </thead>
              <tbody>
                {order.shipments.map(s => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-3 font-medium">{s.carrier || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell font-mono text-xs">
                      {(() => {
                        const url = trackingUrl(s.carrier, s.tracking_number)
                        return url
                          ? <a href={url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{s.tracking_number}</a>
                          : <span className="text-slate-500">{s.tracking_number || '—'}</span>
                      })()}
                    </td>
                    <td className="px-4 py-3"><Badge color={s.status === 'Envoyé' ? 'green' : 'yellow'}>{s.status}</Badge></td>
                    <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(s.shipped_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Notes */}
        {order.notes && (
          <div className="card p-5">
            <h2 className="font-semibold text-slate-900 mb-2">Notes</h2>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{order.notes}</p>
          </div>
        )}
      </div>

      <Modal isOpen={showAddItem} onClose={() => setShowAddItem(false)} title="Ajouter un article">
        <AddItemModal orderId={id} onSave={load} onClose={() => setShowAddItem(false)} />
      </Modal>

      <Modal isOpen={showAddShipment} onClose={() => setShowAddShipment(false)} title="Ajouter une expédition">
        <AddShipmentModal orderId={id} onSave={load} onClose={() => setShowAddShipment(false)} />
      </Modal>

      <ConfirmModal
        isOpen={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        onConfirm={() => handleDeleteItem(deleteItem?.id)}
        title="Supprimer l'article"
        message={`Supprimer "${deleteItem?.product_name}" de cette commande?`}
        confirmLabel="Supprimer"
        danger
      />
    </Layout>
  )
}
