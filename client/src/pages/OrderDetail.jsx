import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Plus, Truck, Package, FileText, X, Download, GripVertical, Copy, Check, Pencil, Trash2 } from 'lucide-react'
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
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [showPdf, setShowPdf] = useState(false)
  const [editingItemId, setEditingItemId] = useState(null)
  const [editingField, setEditingField] = useState(null)
  const [editValues, setEditValues] = useState({})
  const [dragItemId, setDragItemId] = useState(null)
  const [dragOverItemId, setDragOverItemId] = useState(null)
  const dragItemsRef = useRef([])
  const [contextMenu, setContextMenu] = useState(null) // { x, y, item }

  async function load() {
    setLoading(true)
    try {
      const data = await api.orders.get(id)
      setOrder(data)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerateBonLivraison() {
    setGeneratingPdf(true)
    try {
      await api.orders.generateBonLivraison(id)
      await load()
    } finally {
      setGeneratingPdf(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function handleDeleteItem(itemId) {
    await api.orders.deleteItem(id, itemId)
    setOrder(o => ({ ...o, items: o.items.filter(i => i.id !== itemId) }))
  }

  function openContextMenu(e, item) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }

  function closeContextMenu() {
    setContextMenu(null)
  }

  async function handleDuplicateItem(itemId) {
    const newItem = await api.orders.duplicateItem(id, itemId)
    const idx = order.items.findIndex(i => i.id === itemId)
    const newItems = [...order.items]
    newItems.splice(idx + 1, 0, { ...newItem, serials: [] })
    setOrder(o => ({ ...o, items: newItems }))
  }

  function startEdit(item, field = 'qty') {
    setEditingItemId(item.id)
    setEditingField(field)
    setEditValues({ qty: item.qty, unit_cost: item.unit_cost, item_type: item.item_type || 'Facturable', notes: item.notes || '' })
  }

  async function saveEdit(itemId) {
    const orig = order.items.find(i => i.id === itemId)
    if (!orig) { setEditingItemId(null); return }
    const changed = {}
    if (parseInt(editValues.qty) !== orig.qty) changed.qty = parseInt(editValues.qty) || 1
    if (parseFloat(editValues.unit_cost) !== orig.unit_cost) changed.unit_cost = parseFloat(editValues.unit_cost) || 0
    if (editValues.item_type !== (orig.item_type || 'Facturable')) changed.item_type = editValues.item_type
    if (editValues.notes !== (orig.notes || '')) changed.notes = editValues.notes
    if (Object.keys(changed).length > 0) {
      await api.orders.updateItem(id, itemId, changed)
      load()
    }
    setEditingItemId(null)
  }

  function cancelEdit() {
    setEditingItemId(null)
    setEditingField(null)
    setEditValues({})
  }

  function handleDragStart(e, itemId) {
    setDragItemId(itemId)
    dragItemsRef.current = order.items.map(i => i.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e, itemId) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverItemId(itemId)
  }

  async function handleDrop(e, targetItemId) {
    e.preventDefault()
    if (!dragItemId || dragItemId === targetItemId) { setDragItemId(null); setDragOverItemId(null); return }
    const ids = [...dragItemsRef.current]
    const fromIdx = ids.indexOf(dragItemId)
    const toIdx = ids.indexOf(targetItemId)
    ids.splice(fromIdx, 1)
    ids.splice(toIdx, 0, dragItemId)
    const reorderData = ids.map((itemId, idx) => ({ id: itemId, sort_order: idx }))
    // Optimistic update — reorder items in local state without reloading
    const itemMap = new Map(order.items.map(i => [i.id, i]))
    const reorderedItems = ids.map(itemId => itemMap.get(itemId)).filter(Boolean)
    setOrder(o => ({ ...o, items: reorderedItems }))
    setDragItemId(null)
    setDragOverItemId(null)
    api.orders.reorderItems(id, reorderData).catch(() => load())
  }

  function handleDragEnd() {
    setDragItemId(null)
    setDragOverItemId(null)
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
              {order.date_commande && ` · Commande du ${fmtDate(order.date_commande)}`}
              {order.assigned_name && ` · ${order.assigned_name}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerateBonLivraison}
              disabled={generatingPdf}
              className="btn-secondary btn-sm flex items-center gap-1.5"
            >
              <FileText size={14} />
              {generatingPdf ? 'Génération...' : 'Bon de livraison'}
            </button>
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
                <th className="w-6 px-2 py-3"></th>
                <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500">Produit</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 w-16">Qté</th>
                <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell w-28">Coût unit.</th>
                <th className="text-right px-3 py-3 text-xs font-semibold text-slate-500 w-24">Total</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell w-32">Type</th>
                <th className="px-3 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Notes</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {order.items?.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-slate-400">
                  <Package size={24} className="mx-auto mb-2 text-slate-300" />
                  Aucun article — cliquez "Ajouter" pour commencer
                </td></tr>
              ) : order.items?.map(item => {
                const isEditing = editingItemId === item.id
                const isDragOver = dragOverItemId === item.id && dragItemId !== item.id
                return (
                  <tr
                    key={item.id}
                    draggable={!isEditing}
                    onDragStart={e => handleDragStart(e, item.id)}
                    onDragOver={e => handleDragOver(e, item.id)}
                    onDrop={e => handleDrop(e, item.id)}
                    onDragEnd={handleDragEnd}
                    onContextMenu={e => openContextMenu(e, item)}
                    className={`border-b border-slate-100 last:border-0 transition-colors
                      ${isDragOver ? 'bg-indigo-50 border-t-2 border-t-indigo-400' : ''}
                      ${dragItemId === item.id ? 'opacity-40' : ''}
                      ${isEditing ? 'bg-amber-50/40' : 'hover:bg-slate-50'}
                    `}
                  >
                    {/* Drag handle */}
                    <td className="px-2 py-2 w-6">
                      <span className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing block">
                        <GripVertical size={14} />
                      </span>
                    </td>

                    {/* Product + thumbnail + serials */}
                    <td className="px-3 py-2">
                      <div className="flex items-start gap-2.5">
                        {item.product_image && (
                          <img
                            src={item.product_image}
                            alt=""
                            className="w-9 h-9 rounded object-cover flex-shrink-0 border border-slate-100"
                            onError={e => { e.target.style.display = 'none' }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 leading-tight">
                            {item.product_id
                              ? <Link to={`/products/${item.product_id}`} className="hover:text-indigo-600 hover:underline">{item.product_name || 'Produit inconnu'}</Link>
                              : (item.product_name || 'Produit inconnu')
                            }
                          </div>
                          {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
                          {item.serials?.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {item.serials.map(s => (
                                <Link
                                  key={s.id}
                                  to={`/serials/${s.id}`}
                                  className="inline-flex items-center gap-1 text-xs font-mono bg-slate-100 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-900 px-1.5 py-0.5 rounded border border-slate-200 hover:border-indigo-300 transition-colors"
                                >
                                  {s.serial}
                                  {s.status && <span className="text-slate-400 text-[10px]">· {s.status}</span>}
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Qty */}
                    <td
                      className={`px-3 py-2 text-center w-16 ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                      onClick={() => !isEditing && startEdit(item, 'qty')}
                    >
                      {isEditing ? (
                        <input
                          type="number" min="1"
                          value={editValues.qty}
                          autoFocus={editingField === 'qty'}
                          onChange={e => setEditValues(v => ({ ...v, qty: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') cancelEdit() }}
                          className="w-14 text-center input py-1 px-1 text-sm"
                        />
                      ) : (
                        <span className="font-bold text-slate-900">{item.qty}</span>
                      )}
                    </td>

                    {/* Unit cost */}
                    <td
                      className={`px-3 py-2 text-right hidden md:table-cell w-28 ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                      onClick={() => !isEditing && startEdit(item, 'unit_cost')}
                    >
                      {isEditing ? (
                        <input
                          type="number" min="0" step="0.01"
                          value={editValues.unit_cost}
                          autoFocus={editingField === 'unit_cost'}
                          onChange={e => setEditValues(v => ({ ...v, unit_cost: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') cancelEdit() }}
                          className="w-24 text-right input py-1 px-1 text-sm"
                        />
                      ) : (
                        <span className="text-slate-500">{fmtCad(item.unit_cost)}</span>
                      )}
                    </td>

                    {/* Total */}
                    <td className="px-3 py-2 text-right w-24">
                      <span className="font-medium text-slate-900">
                        {isEditing
                          ? fmtCad((parseInt(editValues.qty) || 0) * (parseFloat(editValues.unit_cost) || 0))
                          : fmtCad(item.qty * item.unit_cost)
                        }
                      </span>
                    </td>

                    {/* Type */}
                    <td
                      className={`px-3 py-2 text-center hidden sm:table-cell w-32 ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                      onClick={() => !isEditing && startEdit(item, 'item_type')}
                    >
                      {isEditing ? (
                        <select
                          value={editValues.item_type}
                          autoFocus={editingField === 'item_type'}
                          onChange={e => setEditValues(v => ({ ...v, item_type: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Escape') cancelEdit() }}
                          className="select py-1 text-xs"
                        >
                          {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <Badge color={ITEM_TYPE_COLORS[item.item_type] || 'gray'}>{item.item_type}</Badge>
                      )}
                    </td>

                    {/* Notes */}
                    <td
                      className={`px-3 py-2 hidden lg:table-cell max-w-[180px] ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                      onClick={() => !isEditing && startEdit(item, 'notes')}
                    >
                      {isEditing ? (
                        <input
                          value={editValues.notes}
                          autoFocus={editingField === 'notes'}
                          onChange={e => setEditValues(v => ({ ...v, notes: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') cancelEdit() }}
                          className="input py-1 text-xs w-full"
                          placeholder="Notes…"
                        />
                      ) : (
                        <span className="text-xs text-slate-500 italic truncate block">{item.notes || <span className="text-slate-300">—</span>}</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-0.5 justify-end">
                        {isEditing ? (
                          <>
                            <button onClick={() => saveEdit(item.id)} className="text-green-600 hover:text-green-700 p-1 rounded transition-colors" title="Enregistrer (Entrée)">
                              <Check size={14} />
                            </button>
                            <button onClick={cancelEdit} className="text-slate-400 hover:text-slate-600 p-1 rounded transition-colors" title="Annuler (Échap)">
                              <X size={14} />
                            </button>
                          </>
                        ) : (
                          <button onClick={() => handleDuplicateItem(item.id)} className="text-slate-400 hover:text-indigo-600 p-1 rounded transition-colors" title="Dupliquer">
                            <Copy size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {order.items?.length > 0 && (
              <tfoot className="border-t border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={4} className="px-5 py-3 text-sm font-semibold text-slate-600">Total facturable</td>
                  <td className="px-3 py-3 text-right font-bold text-indigo-600">{fmtCad(billableValue)}</td>
                  <td colSpan={3}></td>
                </tr>
                {totalValue !== billableValue && (
                  <tr>
                    <td colSpan={4} className="px-5 py-2 text-xs text-slate-400">Total tous articles</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-400">{fmtCad(totalValue)}</td>
                    <td colSpan={3}></td>
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

        {/* Bon de livraison — thumbnail */}
        {order.bon_livraison_path && (() => {
          const pdfUrl = `/erp/api/bons-livraison/${order.bon_livraison_path.replace('bons-livraison/', '')}`
          return (
            <div className="card p-5">
              <h2 className="font-semibold text-slate-900 text-sm mb-3">Bon de livraison</h2>
              <button
                onClick={() => setShowPdf(true)}
                className="group relative w-40 h-52 bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-indigo-400 hover:shadow-md transition-all"
              >
                <iframe
                  src={`${pdfUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                  className="w-[200%] h-[200%] origin-top-left scale-50 pointer-events-none"
                  title="Aperçu bon de livraison"
                />
                <div className="absolute inset-0 bg-transparent group-hover:bg-indigo-600/5 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 bg-indigo-600 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg transition-opacity">
                    Ouvrir
                  </span>
                </div>
              </button>
            </div>
          )
        })()}

        {/* PDF viewer modal */}
        {showPdf && order.bon_livraison_path && (() => {
          const pdfUrl = `/erp/api/bons-livraison/${order.bon_livraison_path.replace('bons-livraison/', '')}`
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdf(false)} />
              <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                  <span className="text-sm font-semibold text-slate-900">Bon de livraison — Commande #{order.order_number}</span>
                  <div className="flex items-center gap-2">
                    <a href={pdfUrl} download className="btn-secondary btn-sm">
                      <Download size={13} /> Télécharger
                    </a>
                    <button onClick={() => setShowPdf(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded transition-colors">
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <iframe src={pdfUrl} className="flex-1 w-full" title="Bon de livraison" />
              </div>
            </div>
          )
        })()}
      </div>

      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} onContextMenu={e => { e.preventDefault(); closeContextMenu() }} />
          <div
            className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[140px] text-sm"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              onClick={() => { handleDeleteItem(contextMenu.item.id); closeContextMenu() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-red-600 hover:bg-red-50 transition-colors"
            >
              <Trash2 size={13} />
              Supprimer
            </button>
          </div>
        </>
      )}

      <Modal isOpen={showAddItem} onClose={() => setShowAddItem(false)} title="Ajouter un article">
        <AddItemModal orderId={id} onSave={load} onClose={() => setShowAddItem(false)} />
      </Modal>

      <Modal isOpen={showAddShipment} onClose={() => setShowAddShipment(false)} title="Ajouter une expédition">
        <AddShipmentModal orderId={id} onSave={load} onClose={() => setShowAddShipment(false)} />
      </Modal>

    </Layout>
  )
}
