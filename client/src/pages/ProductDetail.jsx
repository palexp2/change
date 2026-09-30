import { useState, useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, FileText, ExternalLink, RefreshCw, Hammer, AlertTriangle, CheckCircle2, Trash2, SlidersHorizontal, ShoppingCart } from 'lucide-react'
import api from '../lib/api.js'
import { Badge, stockStatusColor, stockStatusLabel } from '../components/Badge.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { Section } from '../components/SectionNav.jsx'
import { useSectionNav } from '../lib/useSectionNav.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { PurchaseOrderModal } from '../components/PurchaseOrderModal.jsx'
import PurchaseDetail from './PurchaseDetail.jsx'
import ProductPurchaseModal from './ProductPurchaseModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TableThumb from '../components/TableThumb.jsx'
import AttachmentPreview from '../components/AttachmentPreview.jsx'
import ImageSlot from '../components/ImageSlot.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META, STOCK_MOVEMENT_TYPES, STOCK_MOVEMENT_TYPE_COLORS, stockMovementSignedQty } from '../lib/tableDefs.js'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { useFieldOverrides, parseNativeChoices } from '../lib/fieldOverrides.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { formatBytes, fmtMoney, fmtNumber } from '../utils/formatters.js'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { Field as GatedField } from '../components/Field.jsx'
import { useRecordDeleteAllowed } from '../lib/detailFieldLayout.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { columnChoiceValues } from '../lib/customFieldDisplay.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useToast } from '../contexts/ToastContext.jsx'


const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']

const PRODUCT_FIELDS = [
  { key: 'sku',                label: 'SKU',                type: 'text' },
  // Sélection : les choix ne sont pas codés ici, ils viennent du registre des
  // champs (/champs/products) — ajouter un type là-bas suffit.
  { key: 'type',               label: 'Type',               type: 'select' },
  { key: 'name_fr',            label: 'Nom (FR)',           type: 'text', span2: true },
  { key: 'name_en',            label: 'Nom (EN)',           type: 'text', span2: true },
  { key: 'unit_cost',          label: 'Coût unitaire (CAD)',type: 'number', step: '0.01' },
  { key: 'price_cad',          label: 'Prix CAD',           type: 'number', step: '0.01' },
  { key: 'price_usd',          label: 'Prix USD',           type: 'number', step: '0.01', defaultVisible: false },
  { key: 'monthly_price_cad',  label: 'Prix mensuel CAD',   type: 'number', step: '0.01', defaultVisible: false },
  { key: 'monthly_price_usd',  label: 'Prix mensuel USD',   type: 'number', step: '0.01', defaultVisible: false },
  { key: 'stock_qty',          label: 'Stock actuel',       type: 'readonly' },
  { key: 'min_stock',          label: 'Stock minimum',      type: 'number' },
  { key: 'order_qty',          label: 'Qté à commander',    type: 'number', defaultVisible: false },
  { key: 'location',           label: 'Emplacement',        type: 'text' },
  { key: 'supplier_company_id',label: 'Fournisseur',        type: 'vendor' },
  { key: 'manufacturier',      label: 'Nom fabricant',      type: 'text' },
  { key: 'supplier',           label: 'Fournisseur (legacy texte)', type: 'text', defaultVisible: false },
  { key: 'buy_via_po',         label: 'Achat par PO',       type: 'checkbox' },
  { key: 'order_email',        label: 'Courriel pour commande', type: 'text', span2: true },
  { key: 'procurement_type',   label: 'Approvisionnement',  type: 'select', options: PROCUREMENT_TYPES },
  { key: 'weight_lbs',         label: 'Poids (lbs)',        type: 'number', step: '0.01', defaultVisible: false },
  { key: 'notes',              label: 'Notes',              type: 'textarea', span2: true, defaultVisible: false },
  { key: 'is_sellable',        label: 'Vendable',           type: 'checkbox' },
  { key: 'quote_farm_wide',    label: 'Soumission : pour toute la ferme', type: 'checkbox' },
  { key: 'active',             label: 'Produit actif',      type: 'checkbox' },
]
// Colonnes rendues AILLEURS que dans la carte de champs (image de l'en-tête,
// section Documents) : sans ça, elles reviendraient en double dans la liste des
// champs de la table proposée par « Ajouter un champ ».
const TAKEN_ELSEWHERE = [
  'image_url',
  'lien_pdf_installation_fr', 'lien_pdf_installation_fr_local',
  'lien_pdf_installation_en', 'lien_pdf_installation_en_local',
  'lien_pdf_remplacement_fr', 'lien_pdf_remplacement_fr_local',
  'lien_pdf_remplacement_en', 'lien_pdf_remplacement_en_local',
]

const ADJUST_REASON = 'raison_de_l_ajustement_manuel'


const BOM_RENDERS = {
  component_image: row => (
    row.component_image_url ? (
      <TableThumb src={row.component_image_url} alt={row.component_name || ''}
        className="border border-slate-200" />
    ) : (
      <div className="h-7 w-7 rounded border border-dashed border-slate-200" />
    )
  ),
  // Composant : lien standard vers la fiche du produit (classe `.link-record`,
  // celle de tous les liens de fiche de l'app), pas un bleu maison.
  component_name: row => (
    row.component_id ? (
      <Link to={`/products/${row.component_id}`} onClick={e => e.stopPropagation()} className="link-record">
        {row.component_name || '—'}
      </Link>
    ) : <span className="font-medium text-slate-900">{row.component_name || '—'}</span>
  ),
  component_sku: row => <span className="text-xs text-slate-500 font-mono">{row.component_sku || '—'}</span>,
  qty_required: row => <span className="font-bold text-slate-900">{row.qty_required ?? '—'}</span>,
  component_stock_qty: row => {
    // Composant sans fiche liée (texte libre) → pas de suivi de stock.
    if (row.component_id == null || row.component_stock_qty == null) return <span className="text-slate-300">—</span>
    const req = row.qty_required > 0 ? row.qty_required : 1
    const insufficient = row.component_stock_qty < req
    return <span className={`font-medium ${insufficient ? 'text-red-600' : 'text-slate-700'}`}>{row.component_stock_qty}</span>
  },
  buildable: row => {
    const b = row.buildable
    if (b == null) return <span className="text-slate-300">—</span>
    return <span className={`font-bold ${b === 0 ? 'text-red-600' : 'text-slate-900'}`}>{b}</span>
  },
  ref_des: row => <span className="text-slate-500 text-xs">{row.ref_des || '—'}</span>,
  product_name: row => (
    row.product_id ? (
      <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="link-record">
        {row.product_name || '—'}
      </Link>
    ) : <span>{row.product_name || '—'}</span>
  ),
  product_sku: row => <span className="text-xs text-slate-500 font-mono">{row.product_sku || '—'}</span>,
}
const BOM_COLUMNS = TABLE_COLUMN_META.bom_items.map(meta => ({ ...meta, render: BOM_RENDERS[meta.id] }))

// Croise le stock courant de chaque composant avec sa quantité requise pour
// déterminer combien d'unités du produit fini sont assemblables maintenant.
// Le composant le plus contraignant fixe la limite (« goulot »).
function computeBuildable(bom) {
  // Annote chaque ligne d'un `buildable` = unités que ce seul composant permet.
  const rows = bom.map(r => {
    if (r.component_id == null || r.component_stock_qty == null) return { ...r, buildable: null }
    const req = r.qty_required > 0 ? r.qty_required : 1
    return { ...r, buildable: Math.floor((r.component_stock_qty || 0) / req) }
  })
  const tracked = rows.filter(r => r.buildable != null)
  const untrackedCount = rows.length - tracked.length
  // Pas de composant suivi → on ne peut rien calculer.
  const units = tracked.length > 0 ? Math.min(...tracked.map(r => r.buildable)) : null
  // Composants « goulot » (ceux qui fixent la limite) et manquants (0 assemblable).
  const bottlenecks = units != null ? tracked.filter(r => r.buildable === units) : []
  const missing = tracked.filter(r => r.buildable === 0)
  return { rows, units, bottlenecks, missing, untrackedCount, trackedCount: tracked.length }
}

// Bannière « Assemblable N unités » + alertes composants manquants / goulots.
function BomBuildableBanner({ summary }) {
  const { units, bottlenecks, missing, untrackedCount, trackedCount } = summary
  if (trackedCount === 0) {
    return (
      <div data-testid="bom-buildable-banner" className="mb-4 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
        <Hammer size={18} className="shrink-0 mt-0.5 text-slate-400" />
        <span>Aucun composant de cette nomenclature n'a de fiche produit liée — impossible de calculer la capacité d'assemblage à partir du stock.</span>
      </div>
    )
  }
  const zero = units === 0
  const tone = zero
    ? 'border-red-200 bg-red-50'
    : units < 5
      ? 'border-amber-200 bg-amber-50'
      : 'border-emerald-200 bg-emerald-50'
  const Icon = zero ? AlertTriangle : CheckCircle2
  const iconTone = zero ? 'text-red-600' : units < 5 ? 'text-amber-600' : 'text-emerald-600'
  const numTone = zero ? 'text-red-700' : units < 5 ? 'text-amber-700' : 'text-emerald-700'
  return (
    <div data-testid="bom-buildable-banner" className={`mb-4 rounded-xl border px-4 py-3 ${tone}`}>
      <div className="flex items-center gap-3">
        <Icon size={22} className={`shrink-0 ${iconTone}`} />
        <div className="flex items-baseline gap-2">
          <span data-testid="bom-buildable-count" className={`text-3xl font-extrabold leading-none ${numTone}`}>{units}</span>
          <span className="text-sm font-medium text-slate-600">
            {units > 1 ? 'unités assemblables' : 'unité assemblable'} avec le stock actuel
          </span>
        </div>
      </div>
      {zero && missing.length > 0 && (
        <div data-testid="bom-missing" className="mt-2 text-sm text-red-700">
          <span className="font-semibold">Composant{missing.length > 1 ? 's' : ''} en rupture : </span>
          {missing.map(r => r.component_name || r.component_sku || '?').join(', ')}
        </div>
      )}
      {!zero && bottlenecks.length > 0 && (
        <div data-testid="bom-bottleneck" className="mt-2 text-sm text-slate-600">
          <span className="font-semibold">Goulot : </span>
          {bottlenecks.map(r => r.component_name || r.component_sku || '?').join(', ')}
          <span className="text-slate-400"> — limite la production à {units}.</span>
        </div>
      )}
      {untrackedCount > 0 && (
        <div className="mt-1.5 text-xs text-slate-400">
          {untrackedCount} composant{untrackedCount > 1 ? 's' : ''} sans fiche/stock liée — non pris en compte.
        </div>
      )}
    </div>
  )
}

const money = n => fmtMoney(n, 'CAD', { fallback: <span className="text-slate-300">—</span> })

const MOVEMENT_RENDERS = {
  created_at:     m => <span className="text-slate-500 text-xs">{fmtDateTime(m.created_at)}</span>,
  type:           m => m.reason
    ? <Badge color={STOCK_MOVEMENT_TYPE_COLORS[m.reason] || 'gray'}>{m.reason}</Badge>
    : <span className="text-slate-400">—</span>,
  // Quantité signée, comme « Changement » dans Airtable et sur /stock-movement.
  qty:            m => <span className="tabular-nums">{fmtNumber(stockMovementSignedQty(m), { fallback: <span className="text-slate-300">—</span> })}</span>,
  user_name:      m => <span className="text-slate-500 text-xs">{m.user_name || '—'}</span>,
  unit_cost:      m => money(m.unit_cost),
  movement_value: m => money(m.movement_value),
}
const MOVEMENT_COLUMNS = TABLE_COLUMN_META.product_movements.map(meta => ({ ...meta, render: MOVEMENT_RENDERS[meta.id] }))

// Sous-tableau « Achats » : `purchases.product_id` a été droppée (migration 035),
// le rattachement passe désormais par le champ lien `nom_de_la_piece` — c'est le
// serveur qui le résout (GET /products/:id/purchases).
const PURCHASE_RENDERS = {
  at_id: p => (
    <Link to={`/purchases/${p.id}`} onClick={e => e.stopPropagation()} className="link-record font-mono text-xs">
      {p.at_id || '—'}
    </Link>
  ),
  quantite_commande: p => <span className="tabular-nums">{fmtNumber(p.quantite_commande, { fallback: <span className="text-slate-300">—</span> })}</span>,
  // Règle FK : le fournisseur s'ouvre si une entreprise est liée. Le miroir
  // Airtable ne remplit souvent que le nom (source de vérité = champ lié).
  supplier: p => (
    p.supplier_company_id ? (
      <Link to={`/companies/${p.supplier_company_id}`} onClick={e => e.stopPropagation()} className="link-record">
        {p.supplier_company_name || p.supplier_vendor_name || '—'}
      </Link>
    ) : <span className="text-slate-600">{p.supplier_company_name || p.supplier_vendor_name || '—'}</span>
  ),
}
const PURCHASE_COLUMNS = TABLE_COLUMN_META.product_purchases.map(meta => ({ ...meta, render: PURCHASE_RENDERS[meta.id] }))

function Field({ label, children, span2 = false }) {
  return (
    <div className={span2 ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  )
}

const SECTION_LABELS = {
  info: 'Informations',
  ajustement: "Ajustement d'inventaire",
  mouvements: 'Mouvements',
  achats: 'Achats',
  bom: 'BOM',
  docs: 'Documents',
}

// Formulaire d'ajustement d'inventaire — écrit via POST /products/:id/stock
// (stock_movements + stock_qty), même route que l'ancien modal orphelin de
// la liste Produits.
function StockAdjustForm({ product, onSaved, onClose }) {
  const current = product.stock_qty ?? 0
  // « Type » d'Airtable ; `target` : la quantité saisie est le nouveau stock,
  // sinon la variation signée (« Changement » dans Airtable).
  const [form, setForm] = useState({ reason: 'Ajustement (augmentation)', target: true, qty: String(current) })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const n = parseInt(form.qty, 10)
  const change = Number.isFinite(n) ? (form.target ? n - current : n) : 0
  // Les deux libellés d'ajustement ne diffèrent que par le sens : un seul choix,
  // le serveur prend le bon d'après le signe.
  const adjusting = /ajustement/i.test(form.reason)
  // Choix et couleurs du champ « Type » tels que configurés, sinon ceux d'Airtable.
  const { overrides } = useFieldOverrides('stock_movements')
  const configured = parseNativeChoices(overrides.get('type'))
  const types = (configured.length ? configured : STOCK_MOVEMENT_TYPES.map(v => ({ value: v, label: v, color: null })))
    .map(c => ({ ...c, color: c.color || STOCK_MOVEMENT_TYPE_COLORS[c.value] || 'gray' }))
    .filter(c => c.value !== 'Ajustement (diminution)')
    .map(c => (c.value === 'Ajustement (augmentation)' ? { ...c, label: 'Ajustement' } : c))
  const typeBadge = c => <Badge color={c.color} className="single-select-label">{c.label}</Badge>

  async function handleSubmit(e) {
    e.preventDefault()
    if (!change) return
    setSaving(true)
    setError(null)
    try {
      await onSaved({ reason: form.reason, change })
      onClose()
    } catch (err) {
      setError(err?.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Type</label>
        <SearchableSelect
          value={form.reason}
          options={types}
          onChange={v => setForm(f => ({ ...f, reason: v }))}
          renderOption={typeBadge}
          renderValue={typeBadge}
          className="input w-full"
          size="sm"
        />
      </div>
      <div>
        <div className="flex gap-1 mb-1">
          {[[true, 'Nouveau stock'], [false, 'Variation']].map(([v, l]) => (
            <button key={l} type="button"
              onClick={() => setForm(f => ({ ...f, target: v, qty: v ? String(current + change) : String(change) }))}
              className={`btn-sm ${form.target === v ? 'btn-primary' : 'btn-secondary'}`}>{l}</button>
          ))}
        </div>
        <input type="number" min={form.target ? 0 : undefined} value={form.qty}
          onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className="input" required autoFocus />
      </div>
      <div className="bg-slate-50 rounded-lg p-3 text-sm tabular-nums">
        {current} → <strong>{current + change}</strong>
        <span className={`ml-2 ${change < 0 ? 'text-red-600' : 'text-emerald-700'}`}>({change > 0 ? '+' : ''}{change})</span>
        {adjusting && change !== 0 && <span className="ml-2 text-slate-500">{change < 0 ? 'Ajustement (diminution)' : 'Ajustement (augmentation)'}</span>}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving || !change} className="btn-primary">{saving ? '...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

// Les sous-tableaux étant empilés, chacun est borné en hauteur selon son nombre
// de lignes (32 px/ligne + l'en-tête collant) pour éviter les grands vides sous
// une table de deux lignes.
function stackedTableHeight(rows) {
  if (!rows) return '190px'
  return `${Math.min(520, Math.max(160, 44 + rows * 32))}px`
}

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) d'une liste : pas de Layout, pas de bouton retour ni de
// titre (le drawer fournit le sien). `onClose` ferme le drawer (utilisé quand
// le produit est supprimé pendant que le drawer est ouvert).
export default function ProductDetail({ recordId, onClose }) {
  const id = recordId
  // « Suppression permise » : case du mode de personnalisation de la fiche.
  const canDelete = useRecordDeleteAllowed('products')
  const [form, setForm] = useState({})
  const [bom, setBom] = useState([])
  const [purchases, setPurchases] = useState([])
  const [companies, setCompanies] = useState([])
  const [showPoModal, setShowPoModal] = useState(false)
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [showStockAdjust, setShowStockAdjust] = useState(false)
  const [showRefreshDocsModal, setShowRefreshDocsModal] = useState(false)
  const [refreshingDocs, setRefreshingDocs] = useState(false)
  const [refreshDocsResult, setRefreshDocsResult] = useState(null)
  const saveTimer = useRef(null)
  const [imageBusy, setImageBusy] = useState(false)
  // Suppression : autorisée seulement si aucun BOM / envoi ne cite la
  // pièce. Le serveur tranche (409) ; on charge son verdict pour griser le
  // bouton et dire pourquoi avant même le clic.
  const [deleteCheck, setDeleteCheck] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const undoableDelete = useUndoableDelete()
  const { addToast } = useToast()
  const { status: saveState, save } = useSaveStatus()
  // Libellés, suppressions et champs personnalisés viennent de la même source
  // que le tableau /champs/products — c'est <DetailFieldGrid> qui les applique.
  // Choix des sélections dont la liste vit dans le registre plutôt que dans le
  // code (`type`) : mêmes valeurs que la colonne du tableau et que le sync
  // Airtable, sans doublon à maintenir ici.
  const { fields: registryFields } = useCustomFields('products')
  const registryChoices = useMemo(() => {
    const map = {}
    for (const f of registryFields || []) {
      const choices = columnChoiceValues({ options: f.options })
      if (choices.length) map[f.column_name] = choices
    }
    return map
  }, [registryFields])
  const bomSummary = useMemo(() => computeBuildable(bom), [bom])

  const { record: product, setRecord: setProduct, loading, loadError, reload: load } =
    useDetailRecord(async () => {
      const data = await api.products.get(id)
      setForm({
        sku: data.sku || '',
        name_fr: data.name_fr || '',
        name_en: data.name_en || '',
        type: data.type || '',
        unit_cost: data.unit_cost ?? 0,
        price_cad: data.price_cad ?? 0,
        price_usd: data.price_usd ?? 0,
        monthly_price_cad: data.monthly_price_cad ?? 0,
        monthly_price_usd: data.monthly_price_usd ?? 0,
        is_sellable: data.is_sellable === 1,
        quote_farm_wide: data.quote_farm_wide === 1,
        min_stock: data.min_stock ?? 0,
        order_qty: data.order_qty ?? 0,
        location: data.location || '',
        supplier: data.supplier || '',
        manufacturier: data.manufacturier || '',
        supplier_company_id: data.supplier_company_id || null,
        supplier_company_name: data.supplier_company?.name || data.supplier || '',
        buy_via_po: data.buy_via_po === 1,
        order_email: data.order_email || '',
        procurement_type: data.procurement_type || '',
        weight_lbs: data.weight_lbs ?? 0,
        notes: data.notes || '',
        active: data.active === 1,
      })
      return data
    }, [id])

  useRealtimeChannel(id ? `product:${id}` : null, (msg) => {
    if (msg.type === 'product:updated') setProduct(p => p ? { ...p, ...msg.payload } : p)
    else if (msg.type === 'product:deleted') onClose?.()
  })

  // Toutes les sections étant visibles simultanément, la nomenclature est
  // chargée au montage (plus de chargement paresseux à la sélection d'un onglet).
  useEffect(() => {
    api.bom.list({ product_id: id, limit: 'all' }).then(r => setBom(r.data || [])).catch(() => {})
    api.products.purchases(id).then(r => setPurchases(r.data || [])).catch(() => setPurchases([]))
    api.products.deleteCheck(id).then(setDeleteCheck).catch(() => setDeleteCheck(null))
  }, [id])

  // Liste des entreprises pour le champ « Fournisseur » (LinkedRecordField).
  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [])

  // Le fournisseur déjà lié doit rester affiché même si la liste n'est pas encore
  // arrivée (ou si l'entreprise a été supprimée) : sans option correspondante,
  // LinkedRecordField retomberait sur son état « vide » et le lien disparaîtrait.
  const vendorOptions = useMemo(() => {
    const vid = form.supplier_company_id
    if (!vid || companies.some(c => String(c.id) === String(vid))) return companies
    return [{ id: vid, name: form.supplier_company_name || 'Fournisseur' }, ...companies]
  }, [companies, form.supplier_company_id, form.supplier_company_name])

  function changeSupplier(vendorId) {
    const company = companies.find(c => String(c.id) === String(vendorId))
    const next = {
      ...form,
      supplier_company_id: vendorId || null,
      supplier_company_name: company?.name || '',
    }
    setForm(next)
    clearTimeout(saveTimer.current)
    save(() => api.products.update(id, next))
  }

  // Dépôt / retrait de l'image de la fiche. Le miroir Airtable ne l'écrasera
  // pas : les fichiers déposés ici sont préfixés `local-` côté serveur.
  async function uploadImage(file) {
    setImageBusy(true)
    await save(async () => {
      const updated = await api.products.uploadImage(id, file)
      setProduct(p => (p ? { ...p, ...updated } : updated))
    })
    setImageBusy(false)
  }

  const leaveRecord = () => onClose?.()

  async function handleDelete() {
    setDeleting(true)
    try {
      await undoableDelete({
        table: 'products',
        id,
        deleteFn: () => api.products.delete(id),
        label: 'Pièce supprimée',
        onChange: syncStore,
      })
      leaveRecord()
    } catch (e) {
      // 409 = BOM / envoi lié : on rafraîchit le verdict pour griser le bouton.
      api.products.deleteCheck(id).then(setDeleteCheck).catch(() => {})
      addToast({ type: 'error', message: e.message || 'Suppression impossible', duration: 6000 })
    } finally {
      setDeleting(false)
    }
  }

  async function removeImage() {
    setImageBusy(true)
    await save(async () => {
      const updated = await api.products.deleteImage(id)
      setProduct(p => (p ? { ...p, ...updated } : updated))
    })
    setImageBusy(false)
  }

  // Section « Ajustement d'inventaire » (comme la fiche Pièce d'Airtable) : la
  // raison part vers Airtable. Le champ « Ajustement manuel » a été retiré de
  // la fiche — l'inventaire s'ajuste par « Ajuster l'inventaire ».
  const [adjust, setAdjust] = useState({ [ADJUST_REASON]: '' })
  const adjustTimers = useRef({})
  // Liens PDF en cours de saisie (autosave par champ via saveAdjust).
  const [docDraft, setDocDraft] = useState({})
  useEffect(() => { setDocDraft({}) }, [id])
  useEffect(() => {
    if (!product) return
    setAdjust({ [ADJUST_REASON]: product[ADJUST_REASON] || '' })
  }, [product?.[ADJUST_REASON]]) // eslint-disable-line react-hooks/exhaustive-deps

  // Un minuteur par champ : choisir la raison ne doit pas annuler la
  // sauvegarde encore en attente de l'ajustement saisi juste avant.
  function saveAdjust(key, val, delay = 0) {
    clearTimeout(adjustTimers.current[key])
    adjustTimers.current[key] = setTimeout(() => {
      save(async () => {
        const { airtable, ...updated } = await api.products.update(id, { [key]: val === '' ? null : val })
        setProduct(p => (p ? { ...p, ...updated } : updated))
        if (airtable?.error) throw new Error(`Airtable : ${airtable.error}`)
      })
    }, delay)
  }

  const sections = useMemo(() => ['info', 'ajustement', 'mouvements', 'achats', 'bom', 'docs'], [])
  const { activeSection, goToSection, registerSection } = useSectionNav(sections, { ready: !loading && !!product })

  const change = (key, val) => {
    const next = { ...form, [key]: val }
    setForm(next)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      save(() => api.products.update(id, next))
    }, 300)
  }

  async function confirmRefreshDocs() {
    setRefreshingDocs(true)
    setRefreshDocsResult(null)
    try {
      const r = await api.products.refreshInstallationDocs(id)
      setProduct(p => ({ ...p, ...r.product }))
      setRefreshDocsResult(r.results || [])
    } catch (e) {
      setRefreshDocsResult([{ field: '_global', status: 'error', error: e.message }])
    } finally {
      setRefreshingDocs(false)
    }
  }

  const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

  // Commande de saisie d'un champ de la carte. Le libellé, la place et la
  // présence du champ sont rendus par <DetailFieldGrid> : la fiche ne fournit
  // plus que l'éditeur.
  function fieldEditor(field) {
    if (field.type === 'readonly') {
      // Non modifiable : texte nu, sans le cadre blanc d'un champ de saisie.
      return <div className="text-sm text-slate-900 py-1.5 tabular-nums">{product[field.key] ?? 0}</div>
    }
    if (field.type === 'checkbox') {
      return (
        <input
          type="checkbox" className="rounded" checked={!!form[field.key]}
          onChange={e => change(field.key, e.target.checked)}
          data-testid={`product-field-${field.key}`}
        />
      )
    }
    if (field.type === 'vendor') {
      // Champ référence : même composante que partout ailleurs dans l'app
      // (LinkedRecordField) — le fournisseur s'affiche comme un lien cliquable
      // vers sa fiche, avec la liste recherchable pour relier ailleurs.
      return (
        <LinkedRecordField
          name="supplier_company_id"
          value={form.supplier_company_id}
          options={vendorOptions}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          saving={saveState === 'saving'}
          onChange={changeSupplier}
        />
      )
    }
    if (field.type === 'select') {
      // Choix codés sur le champ, sinon ceux du registre. La valeur en place
      // s'ajoute si elle n'y figure pas (donnée héritée du sync) : sans ça le
      // champ s'afficherait vide et l'effacerait à la première sauvegarde.
      const declared = field.options || registryChoices[field.key] || []
      const current = form[field.key] || ''
      const options = current && !declared.includes(current) ? [current, ...declared] : declared
      // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
      return options.length > 10 ? (
        <SearchableSelect
          value={current}
          options={options.map(o => ({ value: o, label: o }))}
          emptyOption="—"
          onChange={v => change(field.key, v)}
          className={inp}
          size="sm"
          testId={`product-field-${field.key}`}
        />
      ) : (
        <select className={inp} value={current} onChange={e => change(field.key, e.target.value)}
          data-testid={`product-field-${field.key}`}>
          <option value="">—</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (field.type === 'textarea') {
      return <textarea className={inp} rows={3} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)} />
    }
    if (field.type === 'number') {
      return (
        <input type="number" min="0" step={field.step || '1'} className={inp}
          value={form[field.key] ?? ''} onChange={e => change(field.key, parseFloat(e.target.value) || 0)} />
      )
    }
    return <input className={inp} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)} />
  }

  const sectionCounts = {
    mouvements: product?.movements?.length || undefined,
    achats: purchases.length || undefined,
    bom: bom.length || undefined,
  }

  const pending = detailPending({ loading, loadError, onRetry: load, record: product, notFound: 'Produit introuvable.' })
  if (pending) return pending

  return (
    <DetailShell
      header={{
        leading: (
          <ImageSlot
            testId="product-image-slot"
            src={product?.image_url}
            alt={form.name_fr}
            size="w-14 h-14"
            busy={imageBusy}
            onPick={uploadImage}
            onRemove={removeImage}
          />
        ),
        badge: product && (
          <>
            <Badge color={stockStatusColor(product)} size="md">{stockStatusLabel(product)}</Badge>
            {!form.active && <Badge color="red">Inactif</Badge>}
            {form.is_sellable && <Badge color="indigo">Vendable</Badge>}
          </>
        ),
        status: <SaveStatus status={saveState} />,
        meta: <span>Stock: <strong>{product?.stock_qty}</strong> / min: {form.min_stock || 0}</span>,
        actions: form.buy_via_po && (
          <button
            onClick={() => setShowPoModal(true)}
            className="btn-primary flex items-center gap-1.5 text-sm"
          >
            <FileText size={14} /> Générer un PO
          </button>
        ),
      }}
      nav={{ sections, labels: SECTION_LABELS, counts: sectionCounts, active: activeSection, onSelect: goToSection, testId: 'product-section-nav' }}
    >
        {/* Sections */}
        <div className="min-w-0">

        <Section id="info" label={SECTION_LABELS.info} registerRef={registerSection('info')}>
          {/* Carte de champs commune : le panneau y gagne son bouton
              « Personnaliser les champs » (ordre, retrait, ajout d'un champ de
              la table, modification du champ par clic droit). Les champs
              personnalisés de la table s'y posent seuls — d'où `record`. */}
          <DetailFieldGrid
            entityType="products"
            linkifyTextUrls
            record={product}
            taken={TAKEN_ELSEWHERE}
            className="card p-6"
            testId="product-fields"
          >
            {PRODUCT_FIELDS.map(field => (
              <DetailField
                key={field.key}
                id={field.key}
                label={field.label}
                span2={field.span2}
                // Champs secondaires : ils attendent dans « Ajouter un champ »
                // plutôt que de charger la carte d'office.
                defaultHidden={field.defaultVisible === false}
              >
                {fieldEditor(field)}
              </DetailField>
            ))}
          </DetailFieldGrid>
        </Section>

        <Section id="ajustement" label={SECTION_LABELS.ajustement} registerRef={registerSection('ajustement')}>
          <div className="card p-6 grid grid-cols-2 gap-4" data-testid="product-adjustment">
            <GatedField table="products" id="stock_qty" label="Quantité en inventaire" className="col-span-2">
              <div className="text-sm text-slate-900 py-1.5 tabular-nums">{product.stock_qty ?? '—'}</div>
            </GatedField>
            <GatedField table="products" id={ADJUST_REASON} label="Raison de l'ajustement manuel">
              {(() => {
                const declared = registryChoices[ADJUST_REASON] || []
                const current = adjust[ADJUST_REASON]
                const options = current && !declared.includes(current) ? [current, ...declared] : declared
                return (
                  <select className={inp} value={current} onChange={e => {
                      const v = e.target.value
                      setAdjust(a => ({ ...a, [ADJUST_REASON]: v }))
                      saveAdjust(ADJUST_REASON, v)
                    }}
                    data-testid={`product-field-${ADJUST_REASON}`}>
                    <option value="">—</option>
                    {options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )
              })()}
            </GatedField>
          </div>
        </Section>

        <Section
          id="mouvements"
          label={SECTION_LABELS.mouvements}
          count={sectionCounts.mouvements}
          registerRef={registerSection('mouvements')}
          action={
            <button onClick={() => setShowStockAdjust(true)} className="btn-secondary btn-sm flex items-center gap-1.5">
              <SlidersHorizontal size={14} /> Ajuster l'inventaire
            </button>
          }
        >
          <DataTable
            table="product_movements"
            columns={MOVEMENT_COLUMNS}
            data={product.movements || []}
            searchFields={['type', 'reason', 'user_name']}
            height={stackedTableHeight(product.movements?.length)}
            emptyState={{ icon: ArrowLeftRight, title: 'Aucun mouvement', description: "Aucune entrée, sortie ou ajustement de stock n'a encore été enregistré pour ce produit." }}
          />
        </Section>

        <Section id="achats" label={SECTION_LABELS.achats} count={sectionCounts.achats} registerRef={registerSection('achats')}
          action={<button type="button" onClick={() => setShowPurchaseModal(true)} className="btn-secondary btn-sm flex items-center gap-1.5">
            <ShoppingCart size={14} /> Ajouter un achat
          </button>}>
          <DataTable
            table="product_purchases"
            columns={PURCHASE_COLUMNS}
            data={purchases}
            searchFields={['at_id', 'supplier_company_name', 'supplier_vendor_name', 'emplacement']}
            height={stackedTableHeight(purchases.length)}
            peek={{
              title: row => row.at_id || 'Achat',
              subtitle: row => row.supplier_company_name || row.supplier_vendor_name || '',
              to: row => `/purchases/${row.id}`,
              width: 680,
              render: (row, { close }) => <PurchaseDetail recordId={row.id} embedded onClose={close} />,
            }}
            emptyState={{ icon: ShoppingCart, title: 'Aucun achat', description: "Aucun achat ne cite cette pièce." }}
          />
        </Section>

        <Section id="bom" label={SECTION_LABELS.bom} count={sectionCounts.bom} registerRef={registerSection('bom')}>
          {bom.length > 0 && <BomBuildableBanner summary={bomSummary} />}
          <DataTable
            table="bom_items"
            columns={BOM_COLUMNS}
            data={bomSummary.rows}
            searchFields={['component_name', 'component_sku', 'ref_des']}
            height={stackedTableHeight(bomSummary.rows.length)}
            // Clic sur une ligne → fiche du composant en side-peek.
            peek={{
              title: row => row.component_name || 'Composant',
              subtitle: row => row.component_sku || '',
              to: row => row.component_id ? `/products/${row.component_id}` : undefined,
              key: 'products',
              width: 720,
              render: (row, { close }) => row.component_id
                ? <ProductDetail recordId={row.component_id} embedded onClose={close} />
                : <div className="p-6 text-sm text-slate-400">—</div>,
            }}
            emptyState={{ icon: Hammer, title: 'Aucune nomenclature', description: "Ce produit n'a aucun composant de nomenclature (BOM)." }}
          />
        </Section>

        <Section id="docs" label={SECTION_LABELS.docs} count={sectionCounts.docs} registerRef={registerSection('docs')}>
        {(() => {
          const docFields = [
            { url: 'lien_pdf_installation_fr', local: 'lien_pdf_installation_fr_local', label: 'Lien PDF installation (FR)' },
            { url: 'lien_pdf_installation_en', local: 'lien_pdf_installation_en_local', label: 'Lien PDF installation (EN)' },
            { url: 'lien_pdf_remplacement_fr', local: 'lien_pdf_remplacement_fr_local', label: 'Lien PDF remplacement (FR)' },
            { url: 'lien_pdf_remplacement_en', local: 'lien_pdf_remplacement_en_local', label: 'Lien PDF remplacement (EN)' },
          ]
          const filled = docFields.filter(f => product[f.url])
          return (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm text-slate-500">
                  Copies locales (mises à jour à la demande à partir des liens Airtable).
                </div>
                <button
                  type="button"
                  onClick={() => setShowRefreshDocsModal(true)}
                  disabled={filled.length === 0}
                  className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  title={filled.length === 0 ? 'Aucun lien à télécharger' : 'Télécharger les PDFs depuis les liens'}
                >
                  <RefreshCw size={14} /> Mettre à jour les PDFs
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {docFields.map(f => {
                  const raw = docDraft[f.url] ?? product[f.url] ?? ''
                  const urls = raw.split(',').map(s => s.trim()).filter(Boolean)
                  const locals = (product[f.local] || '').split(',').map(s => s.trim()).filter(Boolean)
                  return (
                    <Field key={f.url} label={f.label} span2>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          className={inp}
                          value={raw}
                          onChange={e => {
                            const v = e.target.value
                            setDocDraft(d => ({ ...d, [f.url]: v }))
                            saveAdjust(f.url, v.trim(), 600)
                          }}
                        />
                        {urls.length === 1 && (
                          <a
                            href={urls[0]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 p-1.5 rounded-lg text-slate-500 hover:text-brand-600 hover:bg-slate-100"
                            title="Ouvrir"
                          >
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </div>
                      {(urls.length > 0 || locals.length > 0) && (
                        <div className="flex flex-wrap gap-3 mt-2">
                          {Array.from({ length: Math.max(urls.length, locals.length) }, (_, i) => {
                            const url = urls[i]
                            const localPath = locals[i] || null
                            const localFilename = localPath ? localPath.replace(/^products\/docs\//, '') : null
                            const localUrl = localFilename ? `/erp/api/product-docs/${encodeURIComponent(localFilename)}` : null
                            return (
                              <div key={localPath || i} className="flex flex-col items-start gap-1.5 min-w-0">
                                {url && urls.length > 1 && (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs link-record truncate"
                                    title={url}
                                  >
                                    <ExternalLink size={12} className="shrink-0" /> [{i + 1}]
                                  </a>
                                )}
                                {localUrl ? (
                                  <AttachmentPreview
                                    url={localUrl}
                                    fileName={localFilename}
                                    title={`${f.label.replace('Lien PDF ', '')}${locals.length > 1 ? ` · ${i + 1}` : ''}`}
                                    kind="pdf"
                                    showFileName={false}
                                    overModal
                                    testId={`product-doc-${f.url}-${i}`}
                                  />
                                ) : (
                                  <div className="text-xs text-slate-400 italic">Aucune copie locale</div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </Field>
                  )
                })}
              </div>
            </div>
          )
        })()}
        </Section>

        </div>

        {/* Suppression — barrée tant qu'un BOM ou un envoi cite la pièce. */}
        {canDelete && (
        <div className="mt-6">
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || deleteCheck?.deletable === false}
            title={deleteCheck?.reason || 'Supprimer cette pièce'}
            data-testid="product-delete"
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
          >
            <Trash2 size={14} />
            {deleting ? 'Suppression…' : 'Supprimer'}
          </button>
          {deleteCheck?.deletable === false && (
            <div className="mt-1 text-xs text-slate-400">{deleteCheck.reason}</div>
          )}
        </div>
        )}

      <PurchaseOrderModal
        productId={id}
        isOpen={showPoModal}
        onClose={() => setShowPoModal(false)}
      />

      <Modal isOpen={showStockAdjust} onClose={() => setShowStockAdjust(false)} title="Ajustement de stock" size="sm">
        {product && (
          <StockAdjustForm
            product={product}
            onSaved={async (data) => {
              await api.products.adjustStock(id, data)
              await load()
              addToast({ message: 'Inventaire ajusté', type: 'success', duration: 3000 })
            }}
            onClose={() => setShowStockAdjust(false)}
          />
        )}
      </Modal>


      {showRefreshDocsModal && (() => {
        const docFields = [
          { url: 'lien_pdf_installation_fr', label: 'PDF installation (FR)' },
          { url: 'lien_pdf_installation_en', label: 'PDF installation (EN)' },
          { url: 'lien_pdf_remplacement_fr', label: 'PDF remplacement (FR)' },
          { url: 'lien_pdf_remplacement_en', label: 'PDF remplacement (EN)' },
        ]
        const parseUrls = v => (v || '').split(',').map(s => s.trim()).filter(Boolean)
        const filled = docFields.map(f => ({ ...f, urls: parseUrls(product[f.url]) })).filter(f => f.urls.length > 0)
        const empty = docFields.filter(f => parseUrls(product[f.url]).length === 0)
        const closeRefreshDocs = () => {
          if (refreshingDocs) return
          setShowRefreshDocsModal(false)
          setRefreshDocsResult(null)
        }
        return (
          // Modale partagée (portail + empilement au-dessus des panneaux
          // latéraux) : la fiche produit s'ouvre elle-même en panneau, souvent
          // empilée par-dessus une commande — une boîte `fixed z-50` locale
          // restait prisonnière du plan du panneau et passait dessous.
          <Modal isOpen onClose={closeRefreshDocs} title="Mettre à jour les PDFs ?" size="md">
              <p className="text-sm text-slate-500 mb-4">
                Cette action effectue les opérations suivantes côté serveur :
              </p>
              <ul className="text-sm text-slate-700 space-y-2 mb-5 list-disc pl-5">
                {filled.map(f => (
                  <li key={f.url}>
                    <strong>{f.label}</strong> : la (les) copie(s) locale(s) actuelle(s) sera supprimée puis
                    remplacée par {f.urls.length === 1 ? 'le PDF téléchargé depuis' : `${f.urls.length} PDFs téléchargés depuis`} :
                    <ul className="mt-1 ml-4 space-y-0.5 list-[circle]">
                      {f.urls.map((u, i) => (
                        <li key={i}>
                          <a href={u} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline break-all">{u}</a>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
                {empty.map(f => (
                  <li key={f.url} className="text-slate-400">
                    <strong>{f.label}</strong> : aucun lien — la copie locale (si présente) sera supprimée.
                  </li>
                ))}
              </ul>
              {refreshDocsResult && (
                <div className="mb-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                  {refreshDocsResult.map((r, i) => {
                    const indexSuffix = typeof r.index === 'number' ? ` [${r.index + 1}]` : ''
                    return (
                      <div key={i} className={r.status === 'error' ? 'text-red-600' : r.status === 'downloaded' ? 'text-emerald-700' : 'text-slate-500'}>
                        <strong>{r.field}{indexSuffix}</strong>: {r.status}
                        {r.bytes ? ` (${formatBytes(r.bytes)})` : ''}
                        {r.error ? ` — ${r.error}` : ''}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeRefreshDocs}
                  disabled={refreshingDocs}
                  className="px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50"
                >
                  {refreshDocsResult ? 'Fermer' : 'Annuler'}
                </button>
                {!refreshDocsResult && (
                  <button
                    type="button"
                    onClick={confirmRefreshDocs}
                    disabled={refreshingDocs || filled.length === 0}
                    className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {refreshingDocs ? (<><RefreshCw size={14} className="animate-spin" /> Téléchargement…</>) : (<><RefreshCw size={14} /> Confirmer</>)}
                  </button>
                )}
              </div>
          </Modal>
        )
      })()}
      {showPurchaseModal && <ProductPurchaseModal key={id} productId={id} onClose={() => setShowPurchaseModal(false)}
        onCreated={purchase => {
          setPurchases(rows => [purchase, ...rows.filter(row => row.id !== purchase.id)])
          if (purchase.airtable.status === 'success') addToast({ message: 'Achat ajouté et synchronisé avec Airtable.' })
        }} />}
    </DetailShell>
  )
}
