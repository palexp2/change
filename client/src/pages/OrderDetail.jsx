import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Plus, Truck, Package, FileText, X, Printer,
  Copy, Check, Trash2, ScanBarcode, Boxes,
  MapPin, Clock, ChevronDown, ChevronRight, AlertCircle, RefreshCw
} from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, orderStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import NovoxpressLabelModal from '../components/NovoxpressLabelModal.jsx'
import EnvoisDetail from './EnvoisDetail.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { RecordOps } from '../lib/recordOps.js'
import { ImageValue, parseSelectChoices } from '../lib/customFieldDisplay.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { trackingUrl } from '../lib/trackingUrl.js'
import { shipmentTitle } from '../lib/shipmentLabel.js'
import { invalidate } from '../lib/prefetch.js'

// ── Utilities ──────────────────────────────────────────────────────────────────

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

// `maxDelay` = intervalle MAX toléré entre deux frappes d'un même code.
// Un pistolet émet ses caractères en rafale puis un Enter terminateur ; on
// repart à zéro seulement après une vraie pause (frappe orpheline restée en
// buffer). 50 ms était trop serré : un scanner Bluetooth ou avec gigue USB/OS
// envoie souvent à 60–100 ms/caractère, avec des pointes occasionnelles bien
// plus hautes. Dès qu'UN seul intervalle dépassait 50 ms, le buffer était vidé
// et il ne restait qu'un caractère → onScan jamais appelé. 500 ms absorbe la
// gigue d'un scanner lent ; l'Enter vide le buffer de toute façon, donc deux
// scans successifs ne fusionnent pas.
function useBarcodeScanner(onScan, { minLength = 3, maxDelay = 500 } = {}) {
  const bufferRef = useRef('')
  const lastTimeRef = useRef(0)

  useEffect(() => {
    // Signale qu'un scanner est actif sur cette page. `Layout` s'en sert pour
    // désactiver ses raccourcis clavier à lettre unique (d/t/b/p/c) : sinon le
    // 1er caractère d'un code (ex. « T » de TH5267 → raccourci /feuille-de-temps)
    // déclenche une navigation avant que le code complet ne soit lu. Compteur
    // (et non booléen) pour rester correct si plusieurs scanners coexistent.
    window.__barcodeScannerActive = (window.__barcodeScannerActive || 0) + 1
    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.ctrlKey || e.metaKey || e.altKey) return

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
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.__barcodeScannerActive = Math.max(0, (window.__barcodeScannerActive || 1) - 1)
    }
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
  // `unit_cost` n'a plus de champ visible (le coût d'une ligne se lit dans
  // « Coût total au moment de l'envoi ») mais reste dans le formulaire : il est
  // pré-rempli avec le coût du produit choisi et posté à la création, sinon la
  // ligne naîtrait à 0 et le gel du coût à l'envoi n'aurait rien à valoriser.
  const [form, setForm] = useState({ product_id: '', qty: 1, unit_cost: '', item_type: 'Facturable' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Catalogue complet, pas une page : au-delà de 200 (`limit` par défaut),
    // le tri alphabétique du serveur coupait la liste en plein milieu — un
    // produit dont le nom commence après le 200e ne sortait jamais.
    api.products.list({ limit: 'all', active: true }).then(r => setProducts(r.data)).catch(() => {})
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
          onChange={handleProductChange}
        />
      </div>
      <div>
        <label className="label">Quantité *</label>
        <input type="number" min="1" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">Type</label>
        <select value={form.item_type} onChange={e => setForm(f => ({ ...f, item_type: e.target.value }))} className="select">
          {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? '...' : 'Ajouter'}</button>
      </div>
    </form>
  )
}

// ── Expedition mode — Pick item row ───────────────────────────────────────────

function PickItemRow({ item, onToggle, onHold, flashId, onUnship, onAddToShipment }) {
  const status = item.fulfillment_status || 'À prélever'
  const isPicked = status === 'Prélevé'
  const isOnHold = status === 'En attente'
  const isLocked = status === "Dans l'envoi" || status === 'Envoyé'
  const isFlashing = flashId === item.id

  const fulfilledQty = item.fulfilled_qty || 0
  const isPartial = !isPicked && !isLocked && !isOnHold && fulfilledQty > 0

  // Locked rows accept a click only when an explicit `onUnship` handler is
  // provided (used by the "Déjà expédié" section to let the user pull an
  // article back out of its shipment). Otherwise locked rows stay inert.
  const clickable = !isLocked || !!onUnship
  const handleRowClick = () => {
    if (isLocked) { if (onUnship) onUnship(item); return }
    onToggle(item)
  }

  return (
    <div
      onClick={() => clickable && handleRowClick()}
      className={`flex items-center gap-4 px-5 py-4 border-b border-slate-100 last:border-0 select-none transition-colors
        ${clickable ? 'cursor-pointer' : 'opacity-50 cursor-default'}
        ${isLocked && onUnship ? 'opacity-80 hover:bg-slate-50' : ''}
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

      {/* Add-to-existing-shipment button — only for "Prélevé" items when at least one shipment exists */}
      {isPicked && onAddToShipment && (
        <button
          onClick={e => { e.stopPropagation(); onAddToShipment(item) }}
          title="Ajouter à un envoi existant"
          className="flex-shrink-0 p-2 rounded-lg text-emerald-700 bg-emerald-100 hover:bg-emerald-200 transition-colors"
        >
          <Truck size={18} />
        </button>
      )}
    </div>
  )
}

// ── Expedition mode — Create shipment modal ────────────────────────────────────

function ExpeditionCreateShipmentModal({ orderId, pickedItems, onSave, onClose }) {
  const [selected, setSelected] = useState(new Set(pickedItems.map(i => i.id)))
  const [form, setForm] = useState({ notes: '' })
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

// ── Expedition mode — Unship confirmation modal ────────────────────────────────

function shipmentLabel(s) {
  if (!s) return ''
  const bits = []
  if (s.carrier) bits.push(s.carrier)
  if (s.tracking_number) bits.push(s.tracking_number)
  return bits.length ? bits.join(' · ') : `envoi ${s.id.slice(0, 6)}`
}

function UnshipConfirmModal({ item, shipment, onConfirm, onClose }) {
  const [saving, setSaving] = useState(false)
  const shipmentSent = shipment?.status === 'Envoyé'
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Retirer <span className="font-semibold text-slate-900">{item.product_name || 'cet article'}</span>
        {item.qty > 1 ? <> (×{item.qty})</> : null} de son envoi ?
      </p>
      <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
        <div className="font-semibold text-slate-700 mb-1.5">Cela va :</div>
        <ul className="list-disc pl-5 text-slate-600 space-y-1">
          <li>retirer l'article de l'envoi <span className="font-medium text-slate-800">{shipmentLabel(shipment)}</span></li>
          <li>remettre son statut à <span className="font-medium text-slate-800">« À prélever »</span></li>
        </ul>
        {shipmentSent && (
          <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
            ⚠ L'envoi est marqué <span className="font-semibold">Envoyé</span> — l'article a peut-être déjà été physiquement expédié.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>Annuler</button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => { setSaving(true); try { await onConfirm() } finally { setSaving(false) } }}
          className="btn-primary"
        >
          {saving ? '...' : 'Retirer de l\'envoi'}
        </button>
      </div>
    </div>
  )
}

// ── Expedition mode — Add-to-existing-shipment modal ───────────────────────────

function AddToShipmentModal({ item, shipments, onConfirm, onClose }) {
  const [selectedId, setSelectedId] = useState(shipments.length === 1 ? shipments[0].id : '')
  const [saving, setSaving] = useState(false)
  const target = shipments.find(s => s.id === selectedId)
  const targetSent = target?.status === 'Envoyé'
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Ajouter <span className="font-semibold text-slate-900">{item.product_name || 'cet article'}</span>
        {item.qty > 1 ? <> (×{item.qty})</> : null} à un envoi existant.
      </p>
      {shipments.length > 1 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-600">Choisir l'envoi cible :</div>
          <div className="space-y-1.5 max-h-64 overflow-auto">
            {shipments.map(s => (
              <label
                key={s.id}
                className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors
                  ${selectedId === s.id ? 'border-brand-300 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}
              >
                <input
                  type="radio"
                  name="ship-target"
                  value={s.id}
                  checked={selectedId === s.id}
                  onChange={() => setSelectedId(s.id)}
                  className="accent-brand-500"
                />
                <span className="flex-1 text-sm">
                  <span className="font-medium text-slate-800">{shipmentLabel(s)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {target && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
          <div className="font-semibold text-slate-700 mb-1.5">Cela va :</div>
          <ul className="list-disc pl-5 text-slate-600 space-y-1">
            <li>rattacher l'article à l'envoi <span className="font-medium text-slate-800">{shipmentLabel(target)}</span></li>
            <li>passer son statut à <span className="font-medium text-slate-800">« Dans l'envoi »</span></li>
            {targetSent && <li>figer le coût unitaire courant comme coût expédié</li>}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>Annuler</button>
        <button
          type="button"
          disabled={saving || !selectedId}
          onClick={async () => { setSaving(true); try { await onConfirm(selectedId) } finally { setSaving(false) } }}
          className="btn-primary"
        >
          {saving ? '...' : 'Ajouter à l\'envoi'}
        </button>
      </div>
    </div>
  )
}

// ── Expedition mode — Full view ────────────────────────────────────────────────

function ExpeditionView({ order, orderId, onUpdate, onPatchItem, onToggleMode, scanToast, setScanToast, flashItemId }) {
  const [showCreateShipment, setShowCreateShipment] = useState(false)
  const [showDoneSection, setShowDoneSection] = useState(false)
  const [unshipItem, setUnshipItem] = useState(null)        // item from "Déjà expédié" awaiting confirmation
  const [addToShipItem, setAddToShipItem] = useState(null)  // picked item awaiting target shipment selection
  const [novoxConfigured, setNovoxConfigured] = useState(false)
  const [labelEnvoi, setLabelEnvoi] = useState(null)        // full envoi (fetched on demand) for Novoxpress modal
  const [openingLabelId, setOpeningLabelId] = useState(null) // shipment id currently being fetched
  const [generatingDocs, setGeneratingDocs] = useState(false)
  const [docsError, setDocsError] = useState(null)

  useEffect(() => {
    api.novoxpress.status().then(r => setNovoxConfigured(!!r.configured)).catch(() => {})
  }, [])

  async function openLabelModal(shipmentId) {
    setOpeningLabelId(shipmentId)
    try {
      const full = await api.shipments.get(shipmentId)
      setLabelEnvoi(full)
    } catch (e) {
      setScanToast({ type: 'error', message: e.message || 'Impossible de charger l\'envoi' })
    } finally {
      setOpeningLabelId(null)
    }
  }

  async function handleGenerateInstallationDocs() {
    setGeneratingDocs(true)
    setDocsError(null)
    try {
      const { blob } = await api.orders.generateInstallationDocsBlob(orderId)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      // Note: ne pas révoquer immédiatement — le nouvel onglet en a besoin
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      setDocsError(e.message || 'Erreur lors de la génération des documents')
    } finally {
      setGeneratingDocs(false)
    }
  }

  const items = order.items || []
  const toPick   = items.filter(i => (i.fulfillment_status || 'À prélever') === 'À prélever')
  const onHold   = items.filter(i => i.fulfillment_status === 'En attente')
  const picked   = items.filter(i => i.fulfillment_status === 'Prélevé')
  const done     = items.filter(i => i.fulfillment_status === "Dans l'envoi" || i.fulfillment_status === 'Envoyé')
  const shipments = order.shipments || []

  const totalItems = items.length
  const doneCount  = picked.length + done.length

  function handleToggle(item) {
    const isPicked = (item.fulfillment_status || 'À prélever') === 'Prélevé'
    const nextStatus = isPicked ? 'À prélever' : 'Prélevé'
    const nextQty   = isPicked ? 0 : item.qty
    // Décochage : on détache aussi les serials côté UI (le serveur fait pareil
    // en DB). Coche : on conserve les serials existants.
    const optimistic = { fulfillment_status: nextStatus, fulfilled_qty: nextQty }
    if (isPicked) optimistic.serials = []
    const prevSerials = item.serials || []
    onPatchItem(item.id, optimistic)
    api.orders.updateItem(orderId, item.id, { fulfillment_status: nextStatus, fulfilled_qty: nextQty }).catch(() => {
      onPatchItem(item.id, { fulfillment_status: item.fulfillment_status, fulfilled_qty: item.fulfilled_qty || 0, serials: prevSerials })
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

  async function confirmUnship() {
    const item = unshipItem
    if (!item) return
    const prev = { shipment_id: item.shipment_id, fulfillment_status: item.fulfillment_status, fulfilled_qty: item.fulfilled_qty }
    const next = { shipment_id: null, fulfillment_status: 'À prélever', fulfilled_qty: 0 }
    onPatchItem(item.id, next)
    setUnshipItem(null)
    try {
      await api.orders.updateItem(orderId, item.id, next)
    } catch {
      onPatchItem(item.id, prev)
    }
  }

  async function confirmAddToShipment(shipmentId) {
    const item = addToShipItem
    if (!item || !shipmentId) return
    const prev = { shipment_id: item.shipment_id, fulfillment_status: item.fulfillment_status }
    const next = { shipment_id: shipmentId, fulfillment_status: "Dans l'envoi" }
    onPatchItem(item.id, next)
    setAddToShipItem(null)
    try {
      await api.orders.updateItem(orderId, item.id, next)
    } catch {
      onPatchItem(item.id, prev)
    }
  }

  const pct = totalItems > 0 ? Math.round((doneCount / totalItems) * 100) : 0

  return (
    <div className="min-h-screen bg-slate-100" data-testid="expedition-view">
      {/* Expedition header — le n° de commande et l'entreprise sont déjà dans
          l'en-tête du panneau : ici, seulement l'avancement du prélèvement. */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-sm font-medium text-slate-600">
              {doneCount} / {totalItems} article{totalItems > 1 ? 's' : ''} prélevé{doneCount > 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-sm font-bold text-slate-700">{pct}%</span>
              <button
                onClick={onToggleMode}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
              >
                <FileText size={13} />
                Vue commerciale
              </button>
            </div>
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

        {/* Avertissement abonnement — privilégier le reconditionné */}
        {order.is_subscription ? (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 shadow-sm">
            <AlertCircle size={20} className="text-amber-600 flex-shrink-0" />
            <span className="font-semibold text-sm">Prendre les produits reconditionnés si possible !</span>
          </div>
        ) : null}

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
              <PickItemRow
                key={item.id}
                item={item}
                onToggle={handleToggle}
                onHold={handleHold}
                flashId={flashItemId}
                onAddToShipment={shipments.length > 0 ? setAddToShipItem : undefined}
              />
            ))}
            <div className="p-4 bg-emerald-50 border-t border-emerald-100 space-y-2">
              <button
                onClick={handleGenerateInstallationDocs}
                disabled={generatingDocs}
                className="w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-medium text-sm py-2.5 rounded-xl transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                title="Fusionne les PDFs d'installation/remplacement (copies locales) pour les articles prêts"
              >
                <FileText size={16} />
                {generatingDocs ? 'Génération…' : 'Générer les documents'}
              </button>
              {docsError && (
                <div className="text-xs text-red-600 px-2">{docsError}</div>
              )}
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
              <PickItemRow
                key={item.id}
                item={item}
                onToggle={() => {}}
                onHold={() => {}}
                flashId={flashItemId}
                onUnship={setUnshipItem}
              />
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
              const isOpening = openingLabelId === s.id
              return (
                <div key={s.id} className="px-5 py-3 border-b border-slate-100 last:border-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    {s.carrier && <span className="text-sm font-medium text-slate-700">{s.carrier}</span>}
                    {s.tracking_number && (
                      url
                        ? <a href={url} target="_blank" rel="noreferrer" className="text-xs font-mono text-brand-600 hover:underline">{s.tracking_number}</a>
                        : <span className="text-xs font-mono text-slate-500">{s.tracking_number}</span>
                    )}
                    <Link
                      to={`/envois/${s.id}`}
                      className="ml-auto text-xs text-slate-500 hover:text-brand-600 hover:underline"
                    >
                      Détails →
                    </Link>
                    {novoxConfigured && (
                      <button
                        onClick={() => openLabelModal(s.id)}
                        disabled={isOpening}
                        className="btn-primary flex items-center gap-1.5 text-xs py-1 px-2.5 disabled:opacity-60"
                        title={s.label_pdf_path ? 'Réimprimer l\'étiquette Novoxpress' : 'Acheter une étiquette Novoxpress'}
                      >
                        {isOpening
                          ? <><div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" /> …</>
                          : <><Printer size={12} /> {s.label_pdf_path ? 'Réimprimer' : 'Étiquette Novoxpress'}</>
                        }
                      </button>
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

      <Modal isOpen={!!unshipItem} onClose={() => setUnshipItem(null)} title="Retirer l'article de l'envoi">
        {unshipItem && (
          <UnshipConfirmModal
            item={unshipItem}
            shipment={shipments.find(s => s.id === unshipItem.shipment_id)}
            onConfirm={confirmUnship}
            onClose={() => setUnshipItem(null)}
          />
        )}
      </Modal>

      <Modal isOpen={!!addToShipItem} onClose={() => setAddToShipItem(null)} title="Ajouter à un envoi existant">
        {addToShipItem && (
          <AddToShipmentModal
            item={addToShipItem}
            shipments={shipments}
            onConfirm={confirmAddToShipment}
            onClose={() => setAddToShipItem(null)}
          />
        )}
      </Modal>

      <Modal isOpen={!!labelEnvoi} onClose={() => setLabelEnvoi(null)} title="Créer une étiquette postale">
        {labelEnvoi && (
          <NovoxpressLabelModal
            envoi={labelEnvoi}
            orderItemsTotalWeight={
              (labelEnvoi.order_items || [])
                .filter(item => item.shipment_id === labelEnvoi.id)
                .reduce((sum, item) => sum + (item.weight_lbs || 0) * (item.qty || 0), 0)
            }
            onClose={() => { setLabelEnvoi(null); onUpdate() }}
            onDone={() => { onUpdate() }}
          />
        )}
      </Modal>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

// `recordId` + `embedded` : monte la fiche dans un RecordPeekDrawer (side-peek)
// sans le chrome de page (Layout, bouton retour). `onClose` ferme le panneau
// après suppression du record.
export default function OrderDetail({ recordId, embedded = true, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content
  const leaveRecord = () => { if (embedded) onClose?.(); else navigate('/orders') }
  const [searchParams] = useSearchParams()
  const { record: order, setRecord: setOrder, loading, loadError, reload: load } =
    useDetailRecord(() => api.orders.get(id), [id])
  // `?mode=expedition` (ex. depuis Priorité d'assemblage → Commande à envoyer)
  // ouvre directement la fiche en mode expédition.
  const [expeditionMode, setExpeditionMode] = useState(() => searchParams.get('mode') === 'expedition')

  // Commercial mode state
  const [showAddItem, setShowAddItem] = useState(false)
  const confirmDialog = useConfirm()
  // Catalogue actif — sert au sélecteur de produit de la cellule « Produit »
  // du tableau des articles (édition en ligne). Même requête que le formulaire
  // d'ajout. `limit: 'all'` : le tri alphabétique du serveur coupait la liste
  // en plein milieu du répertoire au-delà de la page par défaut (200) — un
  // produit dont le nom vient après ne sortait jamais du sélecteur.
  const [products, setProducts] = useState([])
  useEffect(() => {
    api.products.list({ limit: 'all', active: true }).then(r => setProducts(r.data || [])).catch(() => {})
  }, [])

  // Shared
  const [scanToast, setScanToast] = useState(null)
  const [flashItemId, setFlashItemId] = useState(null)

  // Rentabilité — brouillons des champs override (revenu et coûts manuels)
  const [overrideDraft, setOverrideDraft] = useState('')
  const [cogsOverrideDraft, setCogsOverrideDraft] = useState('')
  const [savingOverride, setSavingOverride] = useState(false)

  // Synchronise les brouillons override avec la commande chargée.
  useEffect(() => {
    setOverrideDraft(order?.revenue_override_cad != null ? String(order.revenue_override_cad) : '')
  }, [order?.id, order?.revenue_override_cad])
  useEffect(() => {
    setCogsOverrideDraft(order?.cogs_override_cad != null ? String(order.cogs_override_cad) : '')
  }, [order?.id, order?.cogs_override_cad])

  // Autosave d'un override de rentabilité (on blur). '' ⇒ null ⇒ valeur calculée.
  // `rawValue` permet de forcer une valeur (ex: bouton effacer) sans dépendre
  // de l'état asynchrone du brouillon.
  async function saveOverrideField(field, setDraft, draft, rawValue) {
    const raw = (rawValue !== undefined ? rawValue : draft).trim()
    const current = order?.[field] ?? null
    const next = raw === '' ? null : Number(raw)
    if (next !== null && !Number.isFinite(next)) {
      setDraft(current != null ? String(current) : '')
      return
    }
    if (next === current) return
    setSavingOverride(true)
    try {
      // Envoi PARTIEL : `{ ...order }` embarquait les colonnes Airtable en
      // import seul, que la route refuse en 400 (AIRTABLE_PULL_EDIT_ERROR) —
      // les overrides ne s'enregistraient plus du tout.
      await api.orders.update(id, { [field]: next })
      await load()
    } finally { setSavingOverride(false) }
  }

  const saveOverride = (rawValue) =>
    saveOverrideField('revenue_override_cad', setOverrideDraft, overrideDraft, rawValue)
  const saveCogsOverride = (rawValue) =>
    saveOverrideField('cogs_override_cad', setCogsOverrideDraft, cogsOverrideDraft, rawValue)

  // ── Champs de la carte : autosave champ par champ ───────────────────────────
  // Un seul chemin pour les champs de <DetailFieldGrid> (champs codés ET champs
  // personnalisés) : PUT partiel, puis application locale du seul champ modifié.
  // On ne fusionne PAS la réponse du PUT — elle porte la colonne legacy Airtable
  // `items` (TEXT JSON) qui écraserait le vrai tableau d'articles.
  const { addToast } = useToast()
  const [fieldSaving, setFieldSaving] = useState({})

  async function saveField(key, value) {
    const next = value === '' || value === undefined ? null : value
    if ((order?.[key] ?? null) === next) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await api.orders.update(id, { [key]: next })
      setOrder(o => (o ? { ...o, [key]: next } : o))
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  // Recalcul des coûts figés à l'envoi : le gel automatique ne remplit que les
  // lignes vides, ce bouton reprend celles déjà envoyées avec les coûts du jour
  // (Pièces + valeur de fabrication de chaque numéro de série).
  const [recomputing, setRecomputing] = useState(false)
  async function recomputeShippedCosts() {
    setRecomputing(true)
    try {
      const r = await api.orders.recomputeShippedCosts(id)
      await load()
      addToast({ message: r.frozen ? `${r.frozen} ligne(s) recalculée(s)` : 'Aucune ligne envoyée', type: 'success' })
    } catch (e) {
      addToast({ message: `Recalcul échoué : ${e.message}`, type: 'error' })
    } finally { setRecomputing(false) }
  }

  // Choix de « Priorité » : c'est un champ perso (custom_fields), ses options
  // s'éditent dans /champs/orders — on les lit là plutôt que de les figer ici.
  const { fields: orderFields } = useCustomFields('orders')
  const priorityOptions = useMemo(() => {
    const row = (orderFields || []).find(f => f.column_name === 'priority')
    return parseSelectChoices(row).map(c => ({ value: c.label ?? c.id, label: c.label ?? c.id }))
  }, [orderFields])

  // ── Notes : édition en ligne ────────────────────────────────────────────────
  // Clic sur le texte (ou sur « Ajouter une note… » quand c'est vide) → textarea
  // qui grandit avec le contenu ; la valeur part au blur (règle autosave), Échap
  // annule, ⌘/Ctrl+Entrée valide. Pas de bouton « Enregistrer ».
  const notesSave = useSaveStatus()
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const notesRef = useRef(null)

  const startEditNotes = () => {
    setNotesDraft(order?.notes || '')
    setEditingNotes(true)
  }

  // Auto-hauteur du textarea (une note fait souvent plusieurs lignes).
  useEffect(() => {
    const el = notesRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editingNotes, notesDraft])

  async function commitNotes() {
    setEditingNotes(false)
    const next = notesDraft.trim() === '' ? null : notesDraft
    const current = order?.notes ?? null
    if (next === current) return
    // On ne fusionne PAS la réponse du PUT dans `order` : la list-row contient la
    // colonne legacy Airtable `items` (TEXT JSON) qui écraserait le vrai tableau
    // d'articles chargé par GET /:id.
    const ok = await notesSave.save(() => api.orders.update(id, { notes: next }))
    if (ok) setOrder(o => (o ? { ...o, notes: next } : o))
  }

  // ── Liens de l'entête : entreprise, projet, factures ────────────────────────
  // Champs référence (règle CLAUDE.md : picker recherchable + lien vers la
  // fiche), déliables/reliables en place. Chaque changement part aussitôt
  // (autosave) puis la commande est relue SANS le spinner de page : nom
  // d'entreprise, nom de projet, liste des factures et rentabilité en dépendent.
  // Une facture se lie par SON order_id (PATCH facture), pas par la commande.
  const linkSave = useSaveStatus()
  const [companies, setCompanies] = useState([])
  const [projects, setProjects] = useState([])
  const [companyFactures, setCompanyFactures] = useState([])
  useEffect(() => {
    api.companies.lookup()
      .then(d => setCompanies(Array.isArray(d) ? d : (d?.data || [])))
      .catch(() => setCompanies([]))
  }, [])
  const companyId = order?.company_id || null
  useEffect(() => {
    let alive = true
    api.projects.list(companyId ? { company_id: companyId, limit: 'all' } : { limit: 'all' })
      .then(r => { if (alive) setProjects(r.data || []) })
      .catch(() => {})
    // Le serveur refuse de lier une facture d'une autre entreprise : on ne
    // propose que celles de l'entreprise de la commande (sans les brouillons
    // « pending », qui ne sont pas encore de vraies factures).
    if (companyId) {
      api.factures.list({ company_id: companyId, limit: 'all' })
        .then(r => { if (alive) setCompanyFactures((r.data || []).filter(f => f.source !== 'pending')) })
        .catch(() => {})
    } else {
      setCompanyFactures([])
    }
    return () => { alive = false }
  }, [companyId])

  // Le record déjà lié est toujours proposé, même absent de la liste (entreprise
  // archivée, liste pas encore chargée) — sinon le champ paraîtrait vide.
  const companyOptions = useMemo(() => {
    if (!order?.company_id || companies.some(c => String(c.id) === String(order.company_id))) return companies
    return [{ id: order.company_id, name: order.company_name || 'Entreprise liée' }, ...companies]
  }, [companies, order?.company_id, order?.company_name])
  const projectOptions = useMemo(() => {
    if (!order?.project_id || projects.some(p => String(p.id) === String(order.project_id))) return projects
    return [{ id: order.project_id, name: order.project_name || 'Projet lié' }, ...projects]
  }, [projects, order?.project_id, order?.project_name])
  const linkedFactureIds = new Set((order?.factures || []).map(f => f.id))
  const factureOptions = companyFactures.filter(f => !linkedFactureIds.has(f.id))

  async function refreshOrder() {
    // Le PATCH d'une facture n'invalide pas /orders : purge explicite avant relecture.
    invalidate(`/orders/${id}`)
    setOrder(await api.orders.get(id))
  }
  const saveLink = (field, value) => linkSave.save(async () => {
    await api.orders.update(id, { [field]: value || null })
    await refreshOrder()
  })
  const setFactureOrder = (factureId, orderId) => linkSave.save(async () => {
    await api.factures.update(factureId, { order_id: orderId })
    await refreshOrder()
  })
  const linkSaving = linkSave.status === 'saving'

  // Realtime: another tab/user mutates this order → merge into local state.
  // Item events (`order:item:*`) need full-record refetch for bulk/reorder
  // because the payload doesn't carry enough; for simple created/updated/
  // deleted we mutate `items` in place.
  useRealtimeChannel(id ? `order:${id}` : null, (msg) => {
    if (msg.type === 'order:updated') {
      // Le payload realtime est la list-row (`buildOrderListRow` côté serveur).
      // La table `orders` contient une colonne legacy `items` (TEXT JSON
      // Airtable d'IDs `recXXX`) qui écraserait le vrai tableau d'items
      // chargé par GET /:id — d'où des crashes `items.map is not a function`
      // au prochain rendu. On strip cette colonne du merge.
      const { items: _legacyItems, ...rest } = msg.payload || {}
      setOrder(o => o ? { ...o, ...rest } : o)
    } else if (msg.type === 'order:deleted') {
      leaveRecord()
    } else if (msg.type === 'order:item:created') {
      setOrder(o => {
        if (!o) return o
        if ((o.items || []).some(i => i.id === msg.payload.id)) return o
        return { ...o, items: [...(o.items || []), { ...msg.payload, serials: [] }] }
      })
    } else if (msg.type === 'order:item:updated') {
      setOrder(o => {
        if (!o) return o
        return { ...o, items: (o.items || []).map(i => i.id === msg.payload.id ? { ...i, ...msg.payload } : i) }
      })
    } else if (msg.type === 'order:item:deleted') {
      setOrder(o => {
        if (!o) return o
        return { ...o, items: (o.items || []).filter(i => i.id !== msg.payload.id) }
      })
    } else if (msg.type === 'order:item:bulk_updated' || msg.type === 'order:item:reordered') {
      // Payload doesn't include the full new item set — refetch.
      load()
    }
  })

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

  // ── Articles : table manipulable (RecordOps) ────────────────────────────────
  // Le DataTable « Articles » est du second type (voir lib/recordOps.js) : clic
  // droit sur une ligne pour la dupliquer/supprimer, « + » sous la dernière
  // ligne pour ajouter un article en place. La ligne créée naît « Facturable »,
  // qté 1, sans produit — le curseur ouvre aussitôt le sélecteur de produit de
  // la cellule « Produit ». Le bouton « Ajouter » (formulaire) reste offert.
  const itemOps = useMemo(() => new RecordOps({
    labels: {
      add: 'Ajouter un article',
      duplicate: "Dupliquer l'article",
      delete: "Supprimer l'article",
      duplicated: 'Article dupliqué',
      deleted: 'Article supprimé',
    },
    create: async () => {
      const created = await api.orders.addItem(id, { qty: 1, item_type: 'Facturable' })
      setOrder(o => (o && !(o.items || []).some(i => i.id === created.id)
        ? { ...o, items: [...(o.items || []), { ...created, serials: [] }] }
        : o))
      return created
    },
    duplicate: async (row) => {
      const created = await api.orders.duplicateItem(id, row.id)
      setOrder(o => {
        if (!o) return o
        const items = [...(o.items || [])]
        const idx = items.findIndex(i => i.id === row.id)
        items.splice(idx === -1 ? items.length : idx + 1, 0, { ...created, serials: [] })
        return { ...o, items }
      })
      return created
    },
    remove: async (row) => {
      await api.orders.deleteItem(id, row.id)
      setOrder(o => (o ? { ...o, items: (o.items || []).filter(i => i.id !== row.id) } : o))
    },
    deleteConfirm: (row) => `Supprimer « ${row.product_name || 'Produit inconnu'} » (×${row.qty}) de la commande ? Cette action est irréversible.`,
  }), [id, setOrder])

  // Édition « tableur » du DataTable Articles : PATCH du champ touché, puis
  // merge de la réponse serveur (qui inclut serials + champs produit joints).
  async function handleItemCellEdit(row, col, value) {
    let v = value
    if (col.field === 'qty') {
      // Le serveur exige un entier positif ; '' (vidage) retombe sur 1.
      v = Math.max(1, Math.round(Number(value) || 0))
    }
    if (col.field === 'item_type' && !v) return // pas de type vide
    const payload = { [col.field]: v }
    // Choix du produit sur une ligne qui n'a pas encore de coût : on emporte le
    // coût du produit, comme le fait le formulaire d'ajout — sinon la ligne
    // reste à 0 et le gel du coût à l'envoi n'a rien à valoriser.
    if (col.field === 'product_id' && v && !Number(row.unit_cost)) {
      const prod = products.find(p => String(p.id) === String(v))
      if (prod?.unit_cost) payload.unit_cost = prod.unit_cost
    }
    const updated = await api.orders.updateItem(id, row.id, payload)
    handlePatchItem(row.id, updated)
  }

  // Réordonnancement drag & drop (poignée DataTable) → sort_order persisté.
  function handleReorderItems(ids) {
    const itemMap = new Map(order.items.map(i => [i.id, i]))
    setOrder(o => ({ ...o, items: ids.map(iId => itemMap.get(iId)).filter(Boolean) }))
    const reorderData = ids.map((itemId, idx) => ({ id: itemId, sort_order: idx }))
    api.orders.reorderItems(id, reorderData).catch(() => load())
  }

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

  // Options de l'éditeur de cellule « Produit » (catalogue actif). Ce hook doit
  // rester au-dessus des returns anticipés ci-dessous : appelé après eux, il
  // change le nombre de hooks entre le rendu « chargement » et le rendu chargé.
  const productLinkOptions = useMemo(
    () => products.map(p => ({ id: p.id, label: p.name_fr || p.name_en || p.sku, sub: p.sku })),
    [products]
  )

  function handlePatchItem(itemId, changes) {
    setOrder(o => ({ ...o, items: o.items.map(i => i.id === itemId ? { ...i, ...changes } : i) }))
  }

  if (loading) return shell(<Spinner center />)
  if (loadError && !order) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!order) return shell(<div className="p-6 text-slate-500">Commande introuvable.</div>)

  // ── Expedition mode ─────────────────────────────────────────────────────────
  if (expeditionMode) {
    return shell(
      <>
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
      </>
    )
  }

  // ── Colonnes du DataTable Articles ──────────────────────────────────────────
  // Méta partagée (tableDefs.order_items) + renders spécifiques à la page.
  // Produit / qté / type s'éditent en mode tableur (double-clic ou Entrée sur
  // la cellule) via handleItemCellEdit — voir ITEM_EDITABLE plus bas.
  const ITEM_RENDERS = {
    // Colonne « Produit » (champ `product_id`, le lien vers la fiche produit) :
    // on affiche le NOM du produit, cliquable — jamais l'id brut. Les numéros de
    // série assignés à la ligne ont leur propre colonne (`serials`).
    product_id: item => (
      <div className="flex items-center min-w-0">
        <span className="font-medium text-slate-900 truncate">
          {item.product_id
            ? <Link to={`/products/${item.product_id}`} onClick={e => e.stopPropagation()} className="hover:text-brand-600 hover:underline">{item.product_name || 'Produit inconnu'}</Link>
            : (item.product_name || 'Produit inconnu')}
        </span>
      </div>
    ),
    serials: item => (item.serials?.length > 0
      ? (
        <div className="flex items-center gap-1 flex-wrap">
          {item.serials.map(s => (
            <Link key={s.id} to={`/serials/${s.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs font-mono bg-slate-100 text-brand-700 hover:bg-brand-50 px-1.5 py-0.5 rounded border border-slate-200 hover:border-brand-300 transition-colors flex-shrink-0">
              {s.serial}
              {s.status && <span className="text-slate-400 text-[10px]">· {s.status}</span>}
            </Link>
          ))}
        </div>
      )
      : <span className="text-slate-300">—</span>),
    qty: item => <span className="font-bold text-slate-900">{item.qty}</span>,
    item_type: item => item.item_type
      ? <Badge color={ITEM_TYPE_COLORS[item.item_type] || 'gray'}>{item.item_type}</Badge>
      : <span className="text-slate-300">—</span>,
    product_location: item => item.product_location
      ? <span className="inline-flex items-center gap-1 text-xs font-mono bg-slate-800 text-white px-2 py-0.5 rounded font-bold">{item.product_location}</span>
      : <span className="text-slate-300">—</span>,
    fulfillment_status: item => {
      const fs = item.fulfillment_status || 'À prélever'
      return <Badge color={FULFILLMENT_STATUS[fs]?.color || 'gray'}>{fs}</Badge>
    },
    // Champ Airtable « # de série » : le champ custom stocke des recordID Airtable
    // bruts. Le serveur les résout en vraies fiches série (de_serie_serials, via
    // serial_numbers.airtable_id) — on les affiche en liens cliquables vers la
    // fiche série plutôt qu'en recXXX. Cette colonne override le champ custom
    // auto-géré de même id (voir columnsWithOwnCf dans DataTable).
    // Champ Airtable « Image » : le champ custom stocke une URL de pièce jointe
    // Airtable qui EXPIRE après quelques heures — la cellule finissait donc par
    // afficher l'URL brute au lieu de l'image. On affiche en priorité l'image du
    // produit lié, stockée localement (`/erp/api/product-images/…`, jamais
    // périmée) et déjà servie par la route commande ; l'URL Airtable ne sert
    // plus que de repli. Cette colonne override le champ custom auto-géré de
    // même id (voir columnsWithOwnCf dans DataTable).
    image: item => (item.product_image || item.image
      ? <ImageValue value={item.product_image || item.image} />
      : <span className="text-slate-300">—</span>),
    de_serie: item => (item.de_serie_serials?.length > 0
      ? (
        <div className="flex items-center gap-1 flex-wrap">
          {item.de_serie_serials.map(s => (
            <Link key={s.id} to={`/serials/${s.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs font-mono bg-slate-100 text-brand-700 hover:bg-brand-50 px-1.5 py-0.5 rounded border border-slate-200 hover:border-brand-300 transition-colors flex-shrink-0">
              {s.serial}
            </Link>
          ))}
        </div>
      )
      : <span className="text-slate-300">—</span>),
    product_stock: item => item.product_stock == null ? <span className="text-slate-300 text-xs">—</span>
      : item.product_stock === 0 ? <Badge color="red">Épuisé</Badge>
      : item.product_stock < item.qty ? <Badge color="yellow">{item.product_stock} en stock</Badge>
      : <Badge color="green">{item.product_stock} en stock</Badge>,
    actions: item => (
      <div className="flex items-center gap-0.5 justify-end" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        <button onClick={() => handleDuplicateItem(item.id)} className="text-slate-400 hover:text-brand-600 p-1 rounded" title="Dupliquer" data-testid={`item-duplicate-${item.id}`}><Copy size={13} /></button>
        <button
          onClick={async () => {
            if (await confirmDialog({
              title: "Supprimer l'article",
              message: `Supprimer « ${item.product_name || 'Produit inconnu'} » (×${item.qty}) de la commande ?`,
              confirmLabel: 'Supprimer',
            })) handleDeleteItem(item.id)
          }}
          className="text-slate-400 hover:text-red-600 p-1 rounded"
          title="Supprimer"
          data-testid={`item-delete-${item.id}`}
        ><Trash2 size={13} /></button>
      </div>
    ),
  }
  // `product_id` est éditable en ligne via son propre éditeur (liste
  // recherchable du catalogue) : sans lui, une ligne ajoutée par le « + » de la
  // table n'aurait aucun moyen de recevoir son produit.
  const ITEM_EDITABLE = new Set(['product_id', 'qty', 'item_type'])
  const itemColumns = TABLE_COLUMN_META.order_items.map(meta => ({
    ...meta,
    render: ITEM_RENDERS[meta.id],
    editable: ITEM_EDITABLE.has(meta.id),
    // Cellule « Produit » : champ référence, donc éditeur de lien (dissocier /
    // associer) plutôt qu'une saisie texte — cf. components/LinkCellEditor.jsx.
    // La liste vient de la page et non du serveur : seuls les produits ACTIFS
    // du catalogue sont proposés, comme dans le formulaire d'ajout.
    ...(meta.id === 'product_id'
      ? { linkTarget: 'products', linkOptions: productLinkOptions }
      : {}),
    ...(meta.id === 'item_type'
      ? { selectChoices: ITEM_TYPES.map(t => ({ id: t, label: t, color: ITEM_TYPE_COLORS[t] || 'gray' })) }
      : {}),
  }))
  // Override du champ custom Airtable « # de série » (id/field = de_serie) : la
  // colonne fournie ici prend le pas sur le champ custom auto-géré (voir
  // columnsWithOwnCf dans DataTable) et affiche des liens vers les fiches série.
  itemColumns.push({
    id: 'image',
    label: 'Image',
    field: 'image',
    sortable: false,
    filterable: false,
    groupable: false,
    editable: false,
    render: ITEM_RENDERS.image,
  })
  itemColumns.push({
    id: 'de_serie',
    label: '# de série',
    field: 'de_serie',
    sortable: false,
    filterable: false,
    groupable: false,
    editable: false,
    render: ITEM_RENDERS.de_serie,
  })

  // ── DataTable Expéditions ───────────────────────────────────────────────────
  // Chaque envoi porte ses articles rattachés (et leurs numéros de série) sous
  // forme de champs dérivés : `_items` / `_serials` pour l'affichage, et les
  // résumés texte `items_summary` / `serials_summary` pour la recherche, les
  // filtres et le copier-coller en mode tableur.
  const envoiRows = (order.shipments || []).map(s => {
    const assignedItems = (order.items || []).filter(i => i.shipment_id === s.id)
    const serials = assignedItems.flatMap(i => (i.serials || []).map(sn => ({ ...sn, product_name: i.product_name })))
    return {
      ...s,
      _items: assignedItems,
      _serials: serials,
      items_summary: assignedItems.map(i => `${i.product_name || 'Produit inconnu'} ×${i.qty}`).join(', '),
      serials_summary: serials.map(sn => sn.serial).join(', '),
    }
  })
  const ENVOI_RENDERS = {
    carrier: s => s.carrier
      ? <span className="font-medium text-slate-900">{s.carrier}</span>
      : <span className="text-slate-300">—</span>,
    tracking_number: s => {
      const url = trackingUrl(s.carrier, s.tracking_number)
      if (!s.tracking_number) return <span className="text-slate-300">—</span>
      return url
        ? <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="font-mono text-xs text-brand-600 hover:underline">{s.tracking_number}</a>
        : <span className="font-mono text-xs text-slate-600">{s.tracking_number}</span>
    },
    status: s => <Badge color={s.status === 'Envoyé' ? 'green' : 'gray'}>{s.status || 'À envoyer'}</Badge>,
    shipped_at: s => <span className="text-slate-500">{s.shipped_at ? fmtDate(s.shipped_at) : '—'}</span>,
    items_summary: s => (s._items.length === 0
      ? <span className="text-slate-300 text-xs">—</span>
      : (
        <div className="flex flex-wrap gap-1">
          {s._items.map(i => (
            <Link
              key={i.id}
              to={`/products/${i.product_id}`}
              onClick={e => e.stopPropagation()}
              className={`text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded ${i.product_id ? 'hover:bg-brand-50 hover:text-brand-700' : 'pointer-events-none'}`}
            >
              {i.product_name || 'Produit inconnu'} ×{i.qty}
            </Link>
          ))}
        </div>
      )),
    serials_summary: s => (s._serials.length === 0
      ? <span className="text-slate-300 text-xs">—</span>
      : (
        <div className="flex flex-wrap gap-1" data-testid="shipment-serials">
          {s._serials.map(sn => (
            <Link
              key={sn.id}
              to={`/serials/${sn.id}`}
              onClick={e => e.stopPropagation()}
              title={sn.product_name}
              className="text-xs font-mono bg-slate-100 text-brand-700 hover:bg-brand-50 px-1.5 py-0.5 rounded border border-slate-200 hover:border-brand-300 transition-colors"
            >
              {sn.serial}
            </Link>
          ))}
        </div>
      )),
  }
  const envoiColumns = TABLE_COLUMN_META.order_envois.map(meta => ({ ...meta, render: ENVOI_RENDERS[meta.id] }))

  // ── Commercial mode ─────────────────────────────────────────────────────────
  return shell(
    <>
      <div className="p-6">

        {/* Header — titre (hors panneau) et actions SEULEMENT : aucun champ ici.
            Statut, type, entreprise, projet, factures et dates vivent dans la
            carte de champs ci-dessous, la seule zone éditable de la fiche. */}
        <div className="flex items-start gap-4 mb-4">
          {!embedded && (
            <button onClick={() => navigate('/orders')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            {!embedded && <PageTitle>Commande #{order.order_number}</PageTitle>}
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

        {/* Carte de champs de la commande — même module que les fiches billet,
            projet ou envoi : l'ordre des champs et ceux qu'on garde se règlent
            depuis la fiche (bouton « Personnaliser les champs » dans l'en-tête
            du panneau latéral, réservé aux admins). Les champs personnalisés de
            la table rejoignent la carte tout seuls et sont modifiables (PUT
            /api/orders accepte les colonnes éditables). */}
        <DetailFieldGrid
          entityType="orders"
          record={order}
          onSaveCustom={saveField}
          savingKeys={fieldSaving}
          className="card p-5 mb-4"
          testId="order-fields"
        >
          <DetailField id="status" label="Statut">
            <div><Badge color={orderStatusColor(order.status)}>{order.status}</Badge></div>
          </DetailField>
          <DetailField id="is_subscription" label="Type">
            <button
              onClick={async () => {
                const newVal = order.is_subscription ? 0 : 1
                await api.orders.update(id, { is_subscription: newVal })
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
          </DetailField>
          <DetailField id="company_id" label="Entreprise" saving={linkSaving}>
            <LinkedRecordField
              name="company_id"
              value={order.company_id}
              options={companyOptions}
              labelFn={c => c.name}
              getHref={c => `/companies/${c.id}`}
              saving={linkSaving}
              onChange={v => saveLink('company_id', v)}
            />
          </DetailField>
          <DetailField id="project_id" label="Projet" saving={linkSaving}>
            <LinkedRecordField
              name="project_id"
              value={order.project_id}
              options={projectOptions}
              labelFn={p => p.name}
              getHref={p => `/projects/${p.id}`}
              saving={linkSaving}
              onChange={v => saveLink('project_id', v)}
            />
          </DetailField>
          <DetailField id="factures" label="Factures" saving={linkSaving}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="order-links">
              {(order.factures || []).map(f => (
                f.order_id === order.id ? (
                  // Liée directement à la commande : chip déliable.
                  <LinkedRecordField
                    key={f.id}
                    name={`facture_${f.id}`}
                    value={f.id}
                    options={[f]}
                    labelFn={x => x.document_number || 'Facture'}
                    getHref={x => `/factures/${x.id}`}
                    saving={linkSaving}
                    onChange={() => setFactureOrder(f.id, null)}
                  />
                ) : (
                  // Arrive par le projet : se délie depuis la facture ou le
                  // projet — même pastille, sans poignée de déliaison.
                  <LinkedRecordField
                    key={f.id}
                    name={`facture_${f.id}`}
                    value={f.id}
                    options={[{ id: f.id, name: f.document_number || 'Facture' }]}
                    getHref={x => `/factures/${x.id}`}
                    disabled
                    allowClear={false}
                  />
                )
              ))}
              {order.company_id && (
                <LinkedRecordField
                  name="facture_add"
                  value=""
                  options={factureOptions}
                  labelFn={x => x.document_number || 'Facture'}
                  saving={linkSaving}
                  onChange={fid => fid && setFactureOrder(fid, order.id)}
                />
              )}
            </div>
          </DetailField>
          <DetailField id="created_at" label="Créée le">
            <div className="text-sm text-slate-700">{fmtDate(order.created_at)}</div>
          </DetailField>
          <DetailField id="date_commande" label="Commande du">
            <div className="text-sm text-slate-700">{order.date_commande ? fmtDate(order.date_commande) : '—'}</div>
          </DetailField>
          <DetailField id="priority" label="Priorité" saving={!!fieldSaving.priority}>
            <SearchableSelect
              value={order.priority || ''}
              options={priorityOptions}
              emptyOption="—"
              onChange={v => saveField('priority', v)}
              className="input text-sm w-full"
              size="sm"
              disabled={!!fieldSaving.priority}
              testId="order-field-priority"
            />
          </DetailField>
          {/* Date de la commande : champ Airtable en import seul — affiché, pas
              éditable (l'écriture serait écrasée au prochain sync). */}
          <DetailField id="date_de_la_commande" label="Date de la commande">
            <div className="text-sm text-slate-700" data-testid="order-field-date">
              {order.date_de_la_commande ? fmtDate(order.date_de_la_commande) : '—'}
            </div>
          </DetailField>
          <DetailField id="notes" label="Notes" span2>
            <SaveStatus status={notesSave.status} className="mb-1" />
            {editingNotes ? (
              <textarea
                ref={notesRef}
                value={notesDraft}
                autoFocus
                onChange={e => setNotesDraft(e.target.value)}
                onBlur={commitNotes}
                onKeyDown={e => {
                  if (e.key === 'Escape') { e.preventDefault(); setEditingNotes(false) }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur() }
                }}
                rows={2}
                className="input text-sm w-full resize-none overflow-hidden"
                data-testid="order-notes-input"
              />
            ) : (
              <p
                role="button"
                tabIndex={0}
                onClick={startEditNotes}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEditNotes() } }}
                title="Cliquer pour modifier"
                className={`text-sm whitespace-pre-wrap cursor-text rounded px-2 py-1 -mx-2 hover:bg-slate-50 ${order.notes ? 'text-slate-600' : 'text-slate-400 italic'}`}
                data-testid="order-notes-text"
              >
                {order.notes || 'Ajouter une note…'}
              </p>
            )}
          </DetailField>
        </DetailFieldGrid>

        {/* Items section — DataTable (vues, filtres, tri, groupement, édition
            tableur, réordonnancement par poignée, duplication/suppression) */}
        <div className="mb-4">
          {/* Pas de bouton « Ajouter » : un article se crée en ligne, par le
              « + » sous la dernière ligne de la table (recordOps). */}
          <h2 className="font-semibold text-slate-900 mb-2">Articles ({order.items?.length || 0})</h2>
          <DataTable
            table="order_items"
            columns={itemColumns}
            data={order.items || []}
            searchFields={['product_name', 'sku']}
            // Les articles s'affichent tous : pas d'ascenseur dans la table,
            // c'est le panneau de la fiche qui défile.
            height="auto"
            onCellEdit={handleItemCellEdit}
            onRowReorder={handleReorderItems}
            // Table manipulable : clic droit = dupliquer/supprimer l'article,
            // « + » sous la dernière ligne = article ajouté en place (voir
            // lib/recordOps.js).
            recordOps={itemOps}
            emptyState={{
              icon: Package,
              title: 'Aucun article',
              description: 'Cliquez « Ajouter » ou scannez un code-barres pour commencer.',
              cta: { label: 'Ajouter un article', icon: Plus, onClick: () => setShowAddItem(true) },
            }}
          />
        </div>

        {/* Shipments section — DataTable (vues, filtres, tri, groupement,
            side-peek sur la fiche envoi) */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-slate-900">Expéditions ({envoiRows.length})</h2>
          </div>
          <DataTable
            table="order_envois"
            columns={envoiColumns}
            data={envoiRows}
            searchFields={['carrier', 'tracking_number', 'status', 'pays', 'items_summary', 'serials_summary', 'notes']}
            // Comme les articles : toutes les expéditions s'affichent, pas
            // d'ascenseur dans la table — c'est le panneau qui défile.
            height="auto"
            peek={{
              title: shipmentTitle,
              subtitle: () => [order.company_name, `Commande #${order.order_number}`].filter(Boolean).join(' · '),
              to: row => `/envois/${row.id}`,
              width: 860,
              render: (row, { close }) => <EnvoisDetail recordId={row.id} embedded onClose={close} />,
            }}
            emptyState={{
              icon: Truck,
              title: 'Aucune expédition',
              // Pas de CTA : les envois se créent uniquement en mode expédition.
              description: "Les expéditions se créent depuis le mode expédition de la commande.",
            }}
          />
        </div>

        {/* Rentabilité */}
        {(() => {
          const p = order.profitability || {}
          const revenue = p.revenue_effective ?? 0
          const cogs = p.cogs ?? 0
          const profit = p.profit ?? (revenue - cogs)
          const margin = p.margin_pct
          const overrideActive = p.revenue_override_cad != null
          const cogsOverrideActive = p.cogs_override_cad != null
          const profitColor = profit > 0 ? 'text-emerald-600' : profit < 0 ? 'text-red-600' : 'text-slate-600'
          return (
            <div className="card mb-4">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
                <h2 className="font-semibold text-slate-900">Rentabilité</h2>
                {savingOverride && <span className="text-xs text-slate-400 animate-pulse">Enregistrement…</span>}
              </div>
              <div className="p-5">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Revenus</div>
                    <div className="text-xl font-bold text-slate-900">{fmtMoney(revenue)}</div>
                    {overrideActive
                      ? <div className="text-xs text-amber-600 mt-0.5">Override · calculé {fmtMoney(p.revenue_computed ?? 0)}</div>
                      : <div className="text-xs text-slate-400 mt-0.5">{order.is_subscription ? '1re facture × 38 (HT)' : 'Factures liées (HT)'}</div>}
                  </div>
                  <div>
                    {/* Libellé en enfant DIRECT du bloc : c'est le crochet des règles
                        `.peek-panel` d'index.css (libellé à gauche, valeur à droite). Enveloppé
                        dans un flex avec le bouton, il ne matchait plus et le chiffre des coûts
                        tombait sous son libellé au lieu de s'aligner avec revenus et profit. */}
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Coûts</div>
                    <div className="flex items-center gap-1.5">
                      <div className="text-xl font-bold text-slate-900">{fmtMoney(cogs)}</div>
                      <button
                        onClick={recomputeShippedCosts}
                        disabled={recomputing}
                        className="text-slate-300 hover:text-slate-600 disabled:opacity-50"
                        title="Recalculer les coûts des lignes envoyées (Pièces + valeur de fabrication de chaque numéro de série)"
                      >
                        <RefreshCw size={12} className={recomputing ? 'animate-spin' : ''} />
                      </button>
                    </div>
                    {cogsOverrideActive
                      ? <div className="text-xs text-amber-600 mt-0.5">Override · calculé {fmtMoney(p.cogs_computed ?? 0)}</div>
                      : <div className="text-xs text-slate-400 mt-0.5">Pièces à l'envoi (Facturable)</div>}
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Profit</div>
                    <div className={`text-xl font-bold ${profitColor}`}>{fmtMoney(profit)}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{margin != null ? `Marge ${margin.toFixed(1)} %` : 'Marge —'}</div>
                  </div>
                </div>
                <div className="border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                      Revenu override (CAD)
                    </label>
                    <div className="flex items-center gap-2 max-w-xs">
                      <input
                        type="number"
                        step="0.01"
                        value={overrideDraft}
                        onChange={e => setOverrideDraft(e.target.value)}
                        onBlur={() => saveOverride()}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                        className="input py-1.5 text-sm w-full"
                      />
                      {overrideDraft.trim() !== '' && (
                        <button
                          onClick={() => { setOverrideDraft(''); saveOverride('') }}
                          className="text-slate-400 hover:text-red-600 p-1 rounded"
                          title="Effacer l'override"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                      Coûts override (CAD)
                    </label>
                    <div className="flex items-center gap-2 max-w-xs">
                      <input
                        type="number"
                        step="0.01"
                        value={cogsOverrideDraft}
                        onChange={e => setCogsOverrideDraft(e.target.value)}
                        onBlur={() => saveCogsOverride()}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                        className="input py-1.5 text-sm w-full"
                      />
                      {cogsOverrideDraft.trim() !== '' && (
                        <button
                          onClick={() => { setCogsOverrideDraft(''); saveCogsOverride('') }}
                          className="text-slate-400 hover:text-red-600 p-1 rounded"
                          title="Effacer l'override"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })()}

      </div>

      <ScanToast toast={scanToast} onClose={() => setScanToast(null)} />

      <Modal isOpen={showAddItem} onClose={() => setShowAddItem(false)} title="Ajouter un article">
        <AddItemModal orderId={id} onSave={load} onClose={() => setShowAddItem(false)} />
      </Modal>
    </>
  )
}
