import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Plus, Truck, Package, FileText, X,
  GripVertical, Copy, Check, Trash2, ScanBarcode, Boxes,
  MapPin, Clock, ChevronDown, ChevronRight, AlertCircle
} from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { fmtDate } from '../lib/formatDate.js'

// ── Utilities ──────────────────────────────────────────────────────────────────

function trackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null
  const c = (carrier || '').toLowerCase()
  if (c.includes('purolator')) return `https://www.purolator.com/en/ship-track/tracking-summary.page?pin=${trackingNumber}`
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${trackingNumber}`
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`
  if (c.includes('postes canada') || c.includes('canada post') || c.includes('cp')) return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${trackingNumber}`
  if (c.includes('canpar')) return `https://www.canpar.com/en/tracking/track.htm?barcode=${trackingNumber}`
  if (c.includes('gls')) return `https://gls-group.eu/EU/en/parcel-tracking?match=${trackingNumber}`
  if (c.includes('nationex')) return `https://nationex.com/reperage/${trackingNumber}`
  return null
}

function _fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

const ITEM_TYPES = ['Facturable', 'Remplacement', 'Non facturable']
const ITEM_TYPE_COLORS = { 'Facturable': 'green', 'Remplacement': 'yellow', 'Non facturable': 'gray' }

const FULFILLMENT_STATUS = {
  'À prélever':   { color: 'slate',   label: 'À prélever' },
  'Prélevé':      { color: 'emerald', label: 'Prélevé' },
  'Dans l\'envoi': { color: 'indigo', label: 'Dans l\'envoi' },
  'Envoyé':       { color: 'green',   label: 'Envoyé' },
  'En attente':   { color: 'amber',   label: 'En attente' },
}

// ── Barcode scanner hook ───────────────────────────────────────────────────────

function useBarcodeScanner(onScan, { minLength = 3, maxDelay = 50 } = {}) {
  const bufferRef = useRef('')
  const lastTimeRef = useRef(0)

  useEffect(() => {
    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const now = Date.now()
      if (now - lastTimeRef.current > maxDelay && bufferRef.current.length > 0) {
        bufferRef.current = ''
      }
      lastTimeRef.current = now

      if (e.key === 'Enter') {
        if (bufferRef.current.length >= minLength) onScan(bufferRef.current)
        bufferRef.current = ''
        return
      }
      if (e.key.length === 1) bufferRef.current += e.key
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onScan, minLength, maxDelay])
}

// ── Scan toast ─────────────────────────────────────────────────────────────────

function ScanToast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onClose, 4000)
    return () => clearTimeout(t)
  }, [toast, onClose])

  if (!toast) return null
  return (
    <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl text-sm font-medium
      ${toast.status === 'error' ? 'bg-red-600 text-white' : toast.status === 'warn' ? 'bg-amber-500 text-white' : 'bg-emerald-600 text-white'}`}>
      <ScanBarcode size={16} />
      <span>{toast.message}</span>
      <button onClick={onClose} className="ml-1 opacity-70 hover:opacity-100"><X size={13} /></button>
    </div>
  )
}

// ── Commercial mode — Add item modal ──────────────────────────────────────────

function AddItemModal({ orderId, onSave, onClose }) {
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ product_id: '', qty: 1, unit_cost: '', item_type: 'Facturable', notes: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.products.list({ limit: 200, active: true }).then(r => setProducts(r.data)).catch(() => {})
  }, [])

  function handleProductChange(newId) {
    const id = newId || ''
    const product = products.find(p => p.id === id)
    setForm(f => ({ ...f, product_id: id, unit_cost: product?.unit_cost || '' }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.orders.addItem(orderId, { ...form, qty: parseInt(form.qty), unit_cost: parseFloat(form.unit_cost) || 0 })
      onSave()
      onClose()
    } finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Produit</label>
        <LinkedRecordField
          name="product_id"
          value={form.product_id}
          options={products}
          labelFn={p => `${p.name_fr}${p.sku ? ` (${p.sku})` : ''}`}
          getHref={p => `/products/${p.id}`}
          placeholder="Produit"
          onChange={handleProductChange}
        />
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

// ── Commercial mode — Add shipment modal ──────────────────────────────────────

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
    } finally { setSaving(false) }
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

// ── Expedition mode — Pick item row ───────────────────────────────────────────

function PickItemRow({ item, onToggle, onHold, flashId }) {
  const status = item.fulfillment_status || 'À prélever'
  const isPicked = status === 'Prélevé'
  const isOnHold = status === 'En attente'
  const isLocked = status === "Dans l'envoi" || status === 'Envoyé'
  const isFlashing = flashId === item.id

  const fulfilledQty = item.fulfilled_qty || 0
  const isPartial = !isPicked && !isLocked && !isOnHold && fulfilledQty > 0

  return (
    <div
      onClick={() => !isLocked && onToggle(item)}
      className={`flex items-center gap-4 px-5 py-4 border-b border-slate-100 last:border-0 select-none transition-colors
        ${isLocked ? 'opacity-50 cursor-default' : 'cursor-pointer'}
        ${isPicked ? 'bg-emerald-50 hover:bg-emerald-100/70' : isOnHold ? 'bg-amber-50 hover:bg-amber-100/60' : isPartial ? 'bg-blue-50 hover:bg-blue-100/60' : 'bg-white hover:bg-slate-50'}
        ${isFlashing ? 'ring-2 ring-inset ring-emerald-400' : ''}
      `}
    >
      {/* Checkbox / progress circle */}
      <div className={`w-9 h-9 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors font-bold text-sm
        ${isPicked ? 'bg-emerald-500 border-emerald-500 text-white' :
          isPartial ? 'bg-blue-500 border-blue-500 text-white' :
          isOnHold ? 'bg-amber-400 border-amber-400 text-white' :
          isLocked ? 'bg-brand-400 border-brand-400 text-white' :
          'border-slate-300 bg-white'}`}
      >
        {isPicked && <Check size={18} strokeWidth={2.5} />}
        {isPartial && <span className="text-xs leading-none">{fulfilledQty}</span>}
        {isOnHold && <Clock size={16} />}
        {isLocked && <Truck size={15} />}
      </div>

      {/* Product image */}
      {item.product_image && (
        <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-slate-100 border border-slate-200">
          <img src={item.product_image} alt="" className={`w-full h-full object-cover ${isPicked || isLocked ? 'opacity-40' : ''}`} />
        </div>
      )}

      {/* Product info */}
      <div className="flex-1 min-w-0">
        <div className={`font-semibold text-lg leading-tight ${isPicked ? 'text-emerald-900 line-through decoration-emerald-400/60' : isLocked ? 'text-slate-400' : 'text-slate-900'}`}>
          {item.product_name || 'Produit inconnu'}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {item.sku && <span className="text-sm font-mono text-slate-400">{item.sku}</span>}
          {item.serials?.map(s => (
            <span key={s.id} className="text-sm font-mono bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded">
              {s.serial}
            </span>
          ))}
        </div>
      </div>

      {/* Location badge */}
      {item.product_location && (
        <div className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono font-bold text-sm
          ${isPicked ? 'bg-emerald-200 text-emerald-800' : 'bg-slate-800 text-white'}`}>
          <MapPin size={12} />
          {item.product_location}
        </div>
      )}

      {/* Qty counter */}
      <div className="flex-shrink-0 text-right">
        {isPartial ? (
          <div className="flex flex-col items-end">
            <span className="text-2xl font-bold tabular-nums text-blue-600">{fulfilledQty}<span className="text-slate-400 text-lg"> / {item.qty}</span></span>
          </div>
        ) : (
          <span className={`text-3xl font-bold tabular-nums ${isPicked ? 'text-emerald-600' : isLocked ? 'text-slate-400' : 'text-slate-800'}`}>
            ×{item.qty}
          </span>
        )}
      </div>

      {/* Hold button */}
      {!isLocked && !isPicked && (
        <button
          onClick={e => { e.stopPropagation(); onHold(item) }}
          title={isOnHold ? 'Remettre en liste' : 'Marquer en attente'}
          className={`flex-shrink-0 p-2 rounded-lg transition-colors
            ${isOnHold ? 'text-amber-600 bg-amber-100 hover:bg-amber-200' : 'text-slate-300 hover:text-amber-500 hover:bg-amber-50'}`}
        >
          <AlertCircle size={18} />
        </button>
      )}
    </div>
  )
}

// ── Expedition mode — Create shipment modal ────────────────────────────────────

function ExpeditionCreateShipmentModal({ orderId, pickedItems, onSave, onClose }) {
  const [selected, setSelected] = useState(new Set(pickedItems.map(i => i.id)))
  const [form, setForm] = useState({ carrier: '', tracking_number: '', notes: '' })
  const [saving, setSaving] = useState(false)

  function toggleItem(id) {
    setSelected(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (selected.size === 0) return
    setSaving(true)
    try {
      await api.orders.addShipment(orderId, { ...form, item_ids: [...selected] })
      onSave()
      onClose()
    } finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Items to include */}
      <div>
        <label className="label mb-2">Articles dans cet envoi</label>
        <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
          {pickedItems.map(item => (
            <label key={item.id} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggleItem(item.id)}
                className="w-4 h-4 rounded text-brand-600"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-900 text-sm">{item.product_name}</div>
                {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
              </div>
              {item.product_location && (
                <span className="text-xs font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{item.product_location}</span>
              )}
              <span className="text-sm font-bold text-slate-600">×{item.qty}</span>
            </label>
          ))}
        </div>
        {selected.size === 0 && <p className="text-xs text-red-500 mt-1">Sélectionnez au moins un article.</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Transporteur</label>
          <input value={form.carrier} onChange={e => setForm(f => ({ ...f, carrier: e.target.value }))} className="input" placeholder="Purolator, FedEx..." />
        </div>
        <div>
          <label className="label">N° de suivi <span className="text-slate-400 font-normal">(optionnel)</span></label>
          <input value={form.tracking_number} onChange={e => setForm(f => ({ ...f, tracking_number: e.target.value }))} className="input" />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" />
      </div>
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving || selected.size === 0} className="btn-primary">
          {saving ? 'Création...' : `Créer l'envoi (${selected.size} article${selected.size > 1 ? 's' : ''})`}
        </button>
      </div>
    </form>
  )
}

// ── Expedition mode — Full view ────────────────────────────────────────────────

function ExpeditionView({ order, orderId, onUpdate, onPatchItem, onToggleMode, scanToast, setScanToast, flashItemId }) {
  const [showCreateShipment, setShowCreateShipment] = useState(false)
  const [showDoneSection, setShowDoneSection] = useState(false)

  const items = order.items || []
  const toPick   = items.filter(i => (i.fulfillment_status || 'À prélever') === 'À prélever')
  const onHold   = items.filter(i => i.fulfillment_status === 'En attente')
  const picked   = items.filter(i => i.fulfillment_status === 'Prélevé')
  const done     = items.filter(i => i.fulfillment_status === "Dans l'envoi" || i.fulfillment_status === 'Envoyé')

  const totalItems = items.length
  const doneCount  = picked.length + done.length

  function handleToggle(item) {
    const isPicked = (item.fulfillment_status || 'À prélever') === 'Prélevé'
    const nextStatus = isPicked ? 'À prélever' : 'Prélevé'
    const nextQty   = isPicked ? 0 : item.qty
    onPatchItem(item.id, { fulfillment_status: nextStatus, fulfilled_qty: nextQty })
    api.orders.updateItem(orderId, item.id, { fulfillment_status: nextStatus, fulfilled_qty: nextQty }).catch(() => {
      onPatchItem(item.id, { fulfillment_status: item.fulfillment_status, fulfilled_qty: item.fulfilled_qty || 0 })
    })
  }

  function handleHold(item) {
    const prev = item.fulfillment_status || 'À prélever'
    const next = prev === 'En attente' ? 'À prélever' : 'En attente'
    onPatchItem(item.id, { fulfillment_status: next })
    api.orders.updateItem(orderId, item.id, { fulfillment_status: next }).catch(() => {
      onPatchItem(item.id, { fulfillment_status: prev })
    })
  }

  const pct = totalItems > 0 ? Math.round((doneCount / totalItems) * 100) : 0

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Expedition header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-slate-900 text-lg">#{order.order_number}</span>
              {order.company_name && <span className="text-slate-500 text-sm truncate">{order.company_name}</span>}
            </div>
          </div>
          <button
            onClick={onToggleMode}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors flex-shrink-0"
          >
            <FileText size={13} />
            Vue commerciale
          </button>
        </div>

        {/* Progress bar */}
        <div className="max-w-3xl mx-auto px-4 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium text-slate-600">
              {doneCount} / {totalItems} article{totalItems > 1 ? 's' : ''} prélevé{doneCount > 1 ? 's' : ''}
            </span>
            <span className="text-sm font-bold text-slate-700">{pct}%</span>
          </div>
          <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">

        {/* À prélever */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Boxes size={16} className="text-slate-400" />
              À prélever
              {toPick.length > 0 && (
                <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-0.5 rounded-full">{toPick.length}</span>
              )}
            </h2>
            <div className="text-xs text-slate-400 flex items-center gap-1">
              <ScanBarcode size={13} />
              Scannez pour prélever
            </div>
          </div>
          {toPick.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">
              <Check size={28} className="mx-auto mb-2 text-emerald-300" strokeWidth={2.5} />
              Tous les articles ont été prélevés
            </div>
          ) : (
            toPick.map(item => (
              <PickItemRow key={item.id} item={item} onToggle={handleToggle} onHold={handleHold} flashId={flashItemId} />
            ))
          )}
        </div>

        {/* En attente */}
        {onHold.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden border-l-4 border-amber-400">
            <div className="px-5 py-3 border-b border-slate-100">
              <h2 className="font-semibold text-amber-700 flex items-center gap-2">
                <Clock size={16} />
                En attente / manquants
                <span className="bg-amber-100 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-full">{onHold.length}</span>
              </h2>
            </div>
            {onHold.map(item => (
              <PickItemRow key={item.id} item={item} onToggle={handleToggle} onHold={handleHold} flashId={flashItemId} />
            ))}
          </div>
        )}

        {/* Sur la table (prélevés) */}
        {picked.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden border-l-4 border-emerald-400">
            <div className="px-5 py-3 border-b border-emerald-100 bg-emerald-50">
              <h2 className="font-semibold text-emerald-800 flex items-center gap-2">
                <Check size={16} strokeWidth={2.5} />
                Sur la table
                <span className="bg-emerald-200 text-emerald-800 text-xs font-bold px-2 py-0.5 rounded-full">{picked.length}</span>
              </h2>
            </div>
            {picked.map(item => (
              <PickItemRow key={item.id} item={item} onToggle={handleToggle} onHold={handleHold} flashId={flashItemId} />
            ))}
            <div className="p-4 bg-emerald-50 border-t border-emerald-100">
              <button
                onClick={() => setShowCreateShipment(true)}
                className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-base py-3.5 rounded-xl transition-colors shadow-sm"
              >
                <Truck size={18} />
                Créer un envoi avec {picked.length} article{picked.length > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {/* Expédiés / dans l'envoi */}
        {done.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <button
              onClick={() => setShowDoneSection(s => !s)}
              className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
            >
              <span className="font-semibold text-slate-500 flex items-center gap-2 text-sm">
                <Truck size={15} />
                Déjà expédié{done.length > 1 ? 's' : ''}
                <span className="bg-slate-100 text-slate-500 text-xs font-bold px-2 py-0.5 rounded-full">{done.length}</span>
              </span>
              {showDoneSection ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
            </button>
            {showDoneSection && done.map(item => (
              <PickItemRow key={item.id} item={item} onToggle={() => {}} onHold={() => {}} flashId={flashItemId} />
            ))}
          </div>
        )}

        {/* Shipments summary */}
        {order.shipments?.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h2 className="font-semibold text-slate-700 text-sm flex items-center gap-2">
                <Truck size={15} className="text-slate-400" />
                Envois de cette commande
              </h2>
            </div>
            {order.shipments.map(s => {
              const assignedItems = items.filter(i => i.shipment_id === s.id)
              const url = trackingUrl(s.carrier, s.tracking_number)
              return (
                <div key={s.id} className="px-5 py-3 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge color={s.status === 'Envoyé' ? 'green' : 'yellow'}>{s.status}</Badge>
                    {s.carrier && <span className="text-sm font-medium text-slate-700">{s.carrier}</span>}
                    {s.tracking_number && (
                      url
                        ? <a href={url} target="_blank" rel="noreferrer" className="text-xs font-mono text-brand-600 hover:underline">{s.tracking_number}</a>
                        : <span className="text-xs font-mono text-slate-500">{s.tracking_number}</span>
                    )}
                  </div>
                  {assignedItems.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {assignedItems.map(i => (
                        <span key={i.id} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">
                          {i.product_name} ×{i.qty}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ScanToast toast={scanToast} onClose={() => setScanToast(null)} />

      <Modal isOpen={showCreateShipment} onClose={() => setShowCreateShipment(false)} title="Créer un envoi">
        <ExpeditionCreateShipmentModal
          orderId={orderId}
          pickedItems={picked}
          onSave={onUpdate}
          onClose={() => setShowCreateShipment(false)}
        />
      </Modal>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OrderDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expeditionMode, setExpeditionMode] = useState(false)

  // Commercial mode state
  const [showAddItem, setShowAddItem] = useState(false)
  const [showAddShipment, setShowAddShipment] = useState(false)
  const [editingItemId, setEditingItemId] = useState(null)
  const [editingField, setEditingField] = useState(null)
  const [editValues, setEditValues] = useState({})
  const [dragItemId, setDragItemId] = useState(null)
  const [dragOverItemId, setDragOverItemId] = useState(null)
  const dragItemsRef = useRef([])
  const [contextMenu, setContextMenu] = useState(null)

  // Shared
  const [scanToast, setScanToast] = useState(null)
  const [flashItemId, setFlashItemId] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const data = await api.orders.get(id)
      setOrder(data)
    } finally { setLoading(false) }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  async function handleDeleteItem(itemId) {
    await api.orders.deleteItem(id, itemId)
    setOrder(o => ({ ...o, items: o.items.filter(i => i.id !== itemId) }))
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
    setEditValues({
      qty: item.qty, unit_cost: item.unit_cost,
      item_type: item.item_type || 'Facturable',
      notes: item.notes || '',
      replaced_serial: item.replaced_serial || ''
    })
  }

  async function saveEdit(itemId) {
    const orig = order.items.find(i => i.id === itemId)
    if (!orig) { setEditingItemId(null); return }
    const changed = {}
    if (parseInt(editValues.qty) !== orig.qty) changed.qty = parseInt(editValues.qty) || 1
    if (parseFloat(editValues.unit_cost) !== orig.unit_cost) changed.unit_cost = parseFloat(editValues.unit_cost) || 0
    if (editValues.item_type !== (orig.item_type || 'Facturable')) changed.item_type = editValues.item_type
    if (editValues.notes !== (orig.notes || '')) changed.notes = editValues.notes
    if (editValues.replaced_serial !== (orig.replaced_serial || '')) changed.replaced_serial = editValues.replaced_serial
    if (Object.keys(changed).length > 0) { await api.orders.updateItem(id, itemId, changed); load() }
    setEditingItemId(null)
  }

  function cancelEdit() { setEditingItemId(null); setEditingField(null); setEditValues({}) }

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
    ids.splice(fromIdx, 1); ids.splice(toIdx, 0, dragItemId)
    const reorderData = ids.map((itemId, idx) => ({ id: itemId, sort_order: idx }))
    const itemMap = new Map(order.items.map(i => [i.id, i]))
    setOrder(o => ({ ...o, items: ids.map(iId => itemMap.get(iId)).filter(Boolean) }))
    setDragItemId(null); setDragOverItemId(null)
    api.orders.reorderItems(id, reorderData).catch(() => load())
  }
  function handleDragEnd() { setDragItemId(null); setDragOverItemId(null) }

  const handleScan = useCallback(async (value) => {
    const mode = expeditionMode ? 'pick' : 'add'
    try {
      const result = await api.orders.scan(id, value, mode)
      if (result.type === 'not_found') {
        setScanToast({ message: `Code non reconnu : ${value}`, status: 'error' })
        return
      }

      if (mode === 'pick') {
        if (result.action === 'not_in_order') {
          setScanToast({ message: `Article non trouvé dans cette commande`, status: 'warn' })
        } else {
          if (result.item) {
            handlePatchItem(result.item.id, {
              fulfilled_qty: result.item.fulfilled_qty,
              fulfillment_status: result.item.fulfillment_status,
            })
            setFlashItemId(result.item.id)
            setTimeout(() => setFlashItemId(null), 1500)
          }
          const name = result.serial?.product_name || result.product?.name_fr || value
          setScanToast({ message: `✓ Prélevé : ${name}`, status: 'ok' })
        }
      } else {
        await load()
        if (result.item) { setFlashItemId(result.item.id); setTimeout(() => setFlashItemId(null), 1500) }
        if (result.type === 'serial') {
          const prod = result.serial.product_name || result.item?.product_name || value
          setScanToast({
            message: result.action === 'added'
              ? `Article ajouté : ${prod} · Série ${result.serial.serial} liée`
              : `Série ${result.serial.serial} liée à ${prod}`,
            status: 'ok'
          })
        } else {
          const prod = result.product?.name_fr || value
          setScanToast({
            message: result.action === 'added'
              ? `Article ajouté : ${prod} (SKU : ${value})`
              : `Qté incrémentée : ${prod} → ${result.item?.qty}`,
            status: 'ok'
          })
        }
      }
    } catch {
      setScanToast({ message: `Erreur lors du scan`, status: 'error' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, expeditionMode])

  useBarcodeScanner(handleScan)

  function handlePatchItem(itemId, changes) {
    setOrder(o => ({ ...o, items: o.items.map(i => i.id === itemId ? { ...i, ...changes } : i) }))
  }

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  }
  if (!order) return <Layout><div className="p-6 text-slate-500">Commande introuvable.</div></Layout>

  // ── Expedition mode ─────────────────────────────────────────────────────────
  if (expeditionMode) {
    return (
      <Layout>
        <ExpeditionView
          order={order}
          orderId={id}
          onUpdate={load}
          onPatchItem={handlePatchItem}
          onToggleMode={() => setExpeditionMode(false)}
          scanToast={scanToast}
          setScanToast={setScanToast}
          flashItemId={flashItemId}
        />
      </Layout>
    )
  }

  // ── Commercial mode ─────────────────────────────────────────────────────────
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
              <button
                onClick={async () => {
                  const newVal = order.is_subscription ? 0 : 1
                  await api.orders.update(id, { ...order, is_subscription: newVal })
                  load()
                }}
                className={`px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                  order.is_subscription
                    ? 'bg-violet-100 text-violet-700 border-violet-200 hover:bg-violet-200'
                    : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                }`}
              >
                {order.is_subscription ? 'Abonnement' : 'Achat'}
              </button>
            </div>
            <div className="text-sm text-slate-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {order.company_name && (
                <Link to={`/companies/${order.company_id}`} className="text-brand-600 hover:underline">{order.company_name}</Link>
              )}
              {order.project_id && (
                <>
                  <span className="text-slate-300">·</span>
                  <Link to={`/projects/${order.project_id}`} className="text-brand-500 hover:underline flex items-center gap-1">
                    {order.project_name || 'Projet'}
                  </Link>
                </>
              )}
              {order.factures?.map(f => (
                <React.Fragment key={f.id}>
                  <span className="text-slate-300">·</span>
                  <Link to={`/factures/${f.id}`} className="text-brand-500 hover:underline flex items-center gap-1">
                    {f.document_number || 'Facture'}
                  </Link>
                </React.Fragment>
              ))}
              <span className="text-slate-300">·</span>
              <span>Créée le {fmtDate(order.created_at)}</span>
              {order.date_commande && <><span className="text-slate-300">·</span><span>Commande du {fmtDate(order.date_commande)}</span></>}
              {order.assigned_name && <><span className="text-slate-300">·</span><span>{order.assigned_name}</span></>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpeditionMode(true)}
              className="btn-secondary btn-sm flex items-center gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            >
              <Truck size={14} />
              Mode expédition
            </button>
          </div>
        </div>

        {/* Notes */}
        {order.notes && (
          <div className="card p-5 mb-4">
            <h2 className="font-semibold text-slate-900 mb-2">Notes</h2>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{order.notes}</p>
          </div>
        )}

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
                <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell w-32">Type</th>
                <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell w-24">Emplacement</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell w-32">Prélèvement</th>
                <th className="text-left px-3 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Série remplacée</th>
                <th className="text-center px-3 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell w-28">Disponibilité</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {order.items?.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-8 text-slate-400">
                  <Package size={24} className="mx-auto mb-2 text-slate-300" />
                  Aucun article — cliquez "Ajouter" pour commencer
                </td></tr>
              ) : order.items?.map(item => {
                const isEditing = editingItemId === item.id
                const isDragOver = dragOverItemId === item.id && dragItemId !== item.id
                const fs = item.fulfillment_status || 'À prélever'
                return (
                  <tr
                    key={item.id}
                    draggable={!isEditing}
                    onDragStart={e => handleDragStart(e, item.id)}
                    onDragOver={e => handleDragOver(e, item.id)}
                    onDrop={e => handleDrop(e, item.id)}
                    onDragEnd={handleDragEnd}
                    onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, item }) }}
                    className={`border-b border-slate-100 last:border-0 transition-colors
                      ${isDragOver ? 'bg-brand-50 border-t-2 border-t-brand-400' : ''}
                      ${dragItemId === item.id ? 'opacity-40' : ''}
                      ${flashItemId === item.id ? 'bg-emerald-50 ring-1 ring-inset ring-emerald-300' : isEditing ? 'bg-amber-50/40' : 'hover:bg-slate-50'}
                    `}
                  >
                    <td className="px-2 py-2 w-6">
                      <span className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing block"><GripVertical size={14} /></span>
                    </td>

                    {/* Product */}
                    <td className="px-3 py-2">
                      <div className="flex items-start gap-2.5">
                        {item.product_image && (
                          <img src={item.product_image} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0 border border-slate-100" onError={e => { e.target.style.display = 'none' }} />
                        )}
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 leading-tight">
                            {item.product_id
                              ? <Link to={`/products/${item.product_id}`} className="hover:text-brand-600 hover:underline">{item.product_name || 'Produit inconnu'}</Link>
                              : (item.product_name || 'Produit inconnu')}
                          </div>
                          {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
                          {item.serials?.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {item.serials.map(s => (
                                <Link key={s.id} to={`/serials/${s.id}`} className="inline-flex items-center gap-1 text-xs font-mono bg-slate-100 text-brand-700 hover:bg-brand-50 px-1.5 py-0.5 rounded border border-slate-200 hover:border-brand-300 transition-colors">
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
                    <td className={`px-3 py-2 text-center w-16 ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`} onClick={() => !isEditing && startEdit(item, 'qty')}>
                      {isEditing ? (
                        <input type="number" min="1" value={editValues.qty} autoFocus={editingField === 'qty'}
                          onChange={e => setEditValues(v => ({ ...v, qty: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') cancelEdit() }}
                          onBlur={() => saveEdit(item.id)}
                          className="w-14 text-center input py-1 px-1 text-sm" />
                      ) : <span className="font-bold text-slate-900">{item.qty}</span>}
                    </td>

                    {/* Type */}
                    <td className={`px-3 py-2 text-center hidden sm:table-cell w-32 ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`} onClick={() => !isEditing && startEdit(item, 'item_type')}>
                      {isEditing ? (
                        <select value={editValues.item_type} autoFocus={editingField === 'item_type'}
                          onChange={e => {
                            const val = e.target.value
                            setEditValues(v => ({ ...v, item_type: val }))
                            if (val !== (item.item_type || 'Facturable')) {
                              api.orders.updateItem(id, item.id, { item_type: val }).then(load).catch(() => {})
                            }
                            setEditingItemId(null)
                          }}
                          onKeyDown={e => { if (e.key === 'Escape') cancelEdit() }}
                          className="select py-1 text-xs">
                          {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : <Badge color={ITEM_TYPE_COLORS[item.item_type] || 'gray'}>{item.item_type}</Badge>}
                    </td>

                    {/* Location */}
                    <td className="px-3 py-2 hidden sm:table-cell w-24">
                      {item.product_location
                        ? <span className="inline-flex items-center gap-1 text-xs font-mono bg-slate-800 text-white px-2 py-0.5 rounded font-bold">{item.product_location}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>

                    {/* Fulfillment status */}
                    <td className="px-3 py-2 text-center hidden md:table-cell w-32">
                      <Badge color={FULFILLMENT_STATUS[fs]?.color || 'gray'}>{fs}</Badge>
                    </td>

                    {/* Série remplacée */}
                    <td className={`px-3 py-2 hidden lg:table-cell ${!isEditing ? 'cursor-pointer hover:bg-slate-100' : ''}`} onClick={() => !isEditing && startEdit(item, 'replaced_serial')}>
                      {isEditing ? (
                        <input value={editValues.replaced_serial} autoFocus={editingField === 'replaced_serial'}
                          onChange={e => setEditValues(v => ({ ...v, replaced_serial: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') cancelEdit() }}
                          onBlur={() => saveEdit(item.id)}
                          className="input py-1 text-xs w-full" placeholder="Ex: SN-12345" />
                      ) : <span className="text-xs font-mono text-slate-600">{item.replaced_serial || <span className="text-slate-300">—</span>}</span>}
                    </td>

                    {/* Disponibilité */}
                    <td className="px-3 py-2 text-center hidden md:table-cell w-28">
                      {item.product_stock == null ? <span className="text-slate-300 text-xs">—</span>
                        : item.product_stock === 0 ? <Badge color="red">Épuisé</Badge>
                        : item.product_stock < item.qty ? <Badge color="yellow">{item.product_stock} en stock</Badge>
                        : <Badge color="green">{item.product_stock} en stock</Badge>}
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-0.5 justify-end">
                        {isEditing ? (
                          <button onClick={cancelEdit} className="text-slate-300 hover:text-slate-500 p-1 rounded" title="Annuler (Échap)"><X size={14} /></button>
                        ) : (
                          <button onClick={() => handleDuplicateItem(item.id)} className="text-slate-400 hover:text-brand-600 p-1 rounded" title="Dupliquer"><Copy size={13} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
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
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Articles</th>
                </tr>
              </thead>
              <tbody>
                {order.shipments.map(s => {
                  const assignedItems = (order.items || []).filter(i => i.shipment_id === s.id)
                  return (
                    <tr key={s.id} onClick={() => navigate(`/envois/${s.id}`)} className="table-row-hover border-b border-slate-100 last:border-0 cursor-pointer">
                      <td className="px-5 py-3 font-medium">{s.carrier || '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell font-mono text-xs">
                        {(() => {
                          const url = trackingUrl(s.carrier, s.tracking_number)
                          return url
                            ? <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{s.tracking_number}</a>
                            : <span className="text-slate-500">{s.tracking_number || '—'}</span>
                        })()}
                      </td>
                      <td className="px-4 py-3"><Badge color={s.status === 'Envoyé' ? 'green' : 'yellow'}>{s.status}</Badge></td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{fmtDate(s.shipped_at)}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {assignedItems.length === 0
                            ? <span className="text-slate-300 text-xs">—</span>
                            : assignedItems.map(i => (
                              <span key={i.id} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{i.product_name} ×{i.qty}</span>
                            ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null) }} />
          <div className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[140px] text-sm" style={{ top: contextMenu.y, left: contextMenu.x }}>
            <button onClick={() => { handleDeleteItem(contextMenu.item.id); setContextMenu(null) }} className="w-full flex items-center gap-2.5 px-3 py-2 text-red-600 hover:bg-red-50 transition-colors">
              <Trash2 size={13} /> Supprimer
            </button>
          </div>
        </>
      )}

      <ScanToast toast={scanToast} onClose={() => setScanToast(null)} />

      <Modal isOpen={showAddItem} onClose={() => setShowAddItem(false)} title="Ajouter un article">
        <AddItemModal orderId={id} onSave={load} onClose={() => setShowAddItem(false)} />
      </Modal>
      <Modal isOpen={showAddShipment} onClose={() => setShowAddShipment(false)} title="Ajouter une expédition">
        <AddShipmentModal orderId={id} onSave={load} onClose={() => setShowAddShipment(false)} />
      </Modal>
    </Layout>
  )
}
