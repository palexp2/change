import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileText, ExternalLink, Download, RefreshCw, Hammer, AlertTriangle, CheckCircle2, PanelRight } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, stockStatusColor, stockStatusLabel } from '../components/Badge.jsx'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { PurchaseOrderModal } from '../components/PurchaseOrderModal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TableThumb from '../components/TableThumb.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useAuth } from '../lib/auth.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { formatBytes } from '../utils/formatters.js'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'


const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']

const PRODUCT_FIELDS = [
  { key: 'sku',                label: 'SKU',                type: 'text' },
  { key: 'type',               label: 'Type',               type: 'text' },
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
  { key: 'active',             label: 'Produit actif',      type: 'checkbox' },
]
const movTypeColor = { in: 'green', out: 'red', adjustment: 'blue' }
const movTypeLabel = { in: 'Entrée', out: 'Sortie', adjustment: 'Ajustement' }

const BOM_RENDERS = {
  component_image: row => (
    row.component_image_url ? (
      <TableThumb src={row.component_image_url} alt={row.component_name || ''}
        className="border border-slate-200" />
    ) : (
      <div className="h-7 w-7 rounded border border-dashed border-slate-200" />
    )
  ),
  component_name: row => (
    row.component_id ? (
      <Link to={`/products/${row.component_id}`} className="font-medium text-blue-600 hover:underline">
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
      <Link to={`/products/${row.product_id}`} className="text-blue-600 hover:underline">
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

const money = n => n == null
  ? <span className="text-slate-300">—</span>
  : new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n)

const MOVEMENT_RENDERS = {
  created_at:     m => <span className="text-slate-500 text-xs">{fmtDateTime(m.created_at)}</span>,
  type:           m => <Badge color={movTypeColor[m.type] || 'gray'}>{movTypeLabel[m.type] || m.type}</Badge>,
  qty:            m => (
    <span className={`font-bold ${m.type === 'in' ? 'text-green-600' : m.type === 'out' ? 'text-red-600' : 'text-blue-600'}`}>
      {m.type === 'in' ? '+' : m.type === 'out' ? '-' : '='}{m.qty}
    </span>
  ),
  reason:         m => <span className="text-slate-600">{m.reason || '—'}</span>,
  user_name:      m => <span className="text-slate-500 text-xs">{m.user_name || '—'}</span>,
  unit_cost:      m => money(m.unit_cost),
  movement_value: m => money(m.movement_value),
}
const MOVEMENT_COLUMNS = TABLE_COLUMN_META.product_movements.map(meta => ({ ...meta, render: MOVEMENT_RENDERS[meta.id] }))

function Field({ label, children, span2 = false }) {
  return (
    <div className={span2 ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  )
}

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) d'une liste : pas de Layout, pas de bouton retour ni de
// titre (le drawer fournit le sien). `onClose` ferme le drawer (utilisé quand
// le produit est supprimé pendant que le drawer est ouvert).
export default function ProductDetail({ recordId, embedded = false, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const { user: _user } = useAuth()
  const [product, setProduct] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [tab, setTab] = useState('info')
  const [form, setForm] = useState({})
  const [bom, setBom] = useState([])
  const [showPoModal, setShowPoModal] = useState(false)
  const [showRefreshDocsModal, setShowRefreshDocsModal] = useState(false)
  const [refreshingDocs, setRefreshingDocs] = useState(false)
  const [refreshDocsResult, setRefreshDocsResult] = useState(null)
  const saveTimer = useRef(null)
  const { status: saveState, save } = useSaveStatus()
  const visibleFields = PRODUCT_FIELDS.filter(f => f.defaultVisible !== false)
  const bomSummary = useMemo(() => computeBuildable(bom), [bom])

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await api.products.get(id)
      setProduct(data)
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
    } catch (e) {
      setLoadError(e?.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  useRealtimeChannel(id ? `product:${id}` : null, (msg) => {
    if (msg.type === 'product:updated') setProduct(p => p ? { ...p, ...msg.payload } : p)
    else if (msg.type === 'product:deleted') { if (embedded) onClose?.(); else navigate('/products') }
  })

  useEffect(() => {
    if (tab === 'bom') {
      api.bom.list({ product_id: id, limit: 'all' }).then(r => setBom(r.data)).catch(() => {})
    }
  }, [tab, id])

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

  // En mode embedded (side-peek), pas de Layout : le drawer fournit le cadre.
  const shell = (content) => (embedded ? content : <Layout>{content}</Layout>)

  if (loading) return shell(<Spinner center />)
  if (loadError && !product) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!product) return shell(<div className="p-6 text-slate-500">Produit introuvable.</div>)

  return shell(
    <>
      <div className={embedded ? 'px-5 py-4' : 'p-6 max-w-4xl mx-auto'}>

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate('/products')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          {product.image_url && (
            <img src={product.image_url} alt={form.name_fr} className={`object-cover rounded-lg border border-slate-200 flex-shrink-0 ${embedded ? 'w-14 h-14' : 'w-20 h-20'}`} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {!embedded && <h1 className="text-2xl font-bold text-slate-900">{form.name_fr || <span className="text-slate-400 italic font-normal">Sans nom</span>}</h1>}
              <Badge color={stockStatusColor(product)} size="md">{stockStatusLabel(product)}</Badge>
              {!form.active && <Badge color="red">Inactif</Badge>}
              {form.is_sellable && <Badge color="indigo">Vendable</Badge>}
              <SaveStatus status={saveState} />
            </div>
            <div className="text-sm text-slate-500 mt-1 flex gap-3 flex-wrap items-center">
              {/* SKU et type sont déjà dans le sous-titre du drawer : on ne les
                  répète pas en mode embarqué. */}
              {!embedded && form.sku && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{form.sku}</span>}
              {!embedded && form.type && <span>{form.type}</span>}
              <span>Stock: <strong>{product.stock_qty}</strong> / min: {form.min_stock || 0}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!embedded && (
              /* Miroir du bouton « ouvrir en grand » du drawer : retourne à la
                 liste avec ce produit ouvert en panneau latéral. */
              <button
                onClick={() => navigate('/products', { state: { peekId: id } })}
                className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg"
                title="Revenir à la liste avec ce produit en panneau latéral"
                aria-label="Ouvrir en panneau latéral"
                data-testid="product-open-as-peek"
              >
                <PanelRight size={16} />
              </button>
            )}
            {form.buy_via_po && form.supplier_company_id && (
              <button
                onClick={() => setShowPoModal(true)}
                className="btn-primary flex items-center gap-1.5 text-sm"
              >
                <FileText size={14} /> Générer un PO
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-slate-200">
          {[
            { key: 'info', label: 'Informations' },
            { key: 'mouvements', label: 'Mouvements de stock' },
            { key: 'bom', label: 'BOM' },
            { key: 'docs', label: 'Document d’installation' },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t.key ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {t.label}
              {t.key === 'mouvements' && product.movements?.length > 0 && (
                <span className="ml-1.5 bg-slate-200 text-slate-600 text-xs px-1.5 py-0.5 rounded-full">{product.movements.length}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'info' && (
          <div className="card p-6">
            <div className="grid grid-cols-2 gap-4">
              {visibleFields.map(field => {
                if (field.type === 'readonly') {
                  return (
                    <Field key={field.key} label={field.label} span2={field.span2}>
                      <div className={`${inp} bg-slate-50 cursor-default`}>{product[field.key] ?? 0}</div>
                    </Field>
                  )
                }
                if (field.type === 'checkbox') {
                  return (
                    <div key={field.key} className="flex items-center">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" className="rounded" checked={!!form[field.key]} onChange={e => change(field.key, e.target.checked)} />
                        <span className="text-sm text-slate-700">{field.label}</span>
                      </label>
                    </div>
                  )
                }
                if (field.type === 'vendor') {
                  return (
                    <Field key={field.key} label={
                      <span className="flex items-center gap-2">
                        {field.label}
                        {form.supplier_company_id && (
                          <Link
                            to={`/companies/${form.supplier_company_id}`}
                            className="text-brand-600 hover:text-brand-800 inline-flex items-center gap-1 text-xs normal-case font-normal tracking-normal"
                            title="Ouvrir la fiche fournisseur"
                          >
                            <ExternalLink size={12} /> Ouvrir la fiche
                          </Link>
                        )}
                      </span>
                    } span2={field.span2}>
                      <VendorSelect
                        value={form.supplier_company_name || ''}
                        vendorId={form.supplier_company_id}
                        onChange={({ vendor, vendor_id }) => {
                          const next = { ...form, supplier_company_name: vendor, supplier_company_id: vendor_id }
                          setForm(next)
                          clearTimeout(saveTimer.current)
                          saveTimer.current = setTimeout(() => {
                            save(() => api.products.update(id, next))
                          }, 300)
                        }}
                      />
                    </Field>
                  )
                }
                if (field.type === 'select') {
                  // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
                  return (
                    <Field key={field.key} label={field.label} span2={field.span2}>
                      {(field.options || []).length > 10 ? (
                        <SearchableSelect
                          value={form[field.key] || ''}
                          options={(field.options || []).map(o => ({ value: o, label: o }))}
                          emptyOption="—"
                          placeholder="—"
                          onChange={v => change(field.key, v)}
                          className={inp}
                          size="sm"
                          testId={`product-field-${field.key}`}
                        />
                      ) : (
                        <select className={inp} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)}>
                          <option value="">—</option>
                          {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      )}
                    </Field>
                  )
                }
                if (field.type === 'textarea') {
                  return (
                    <Field key={field.key} label={field.label} span2={field.span2}>
                      <textarea className={inp} rows={3} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)} />
                    </Field>
                  )
                }
                if (field.type === 'number') {
                  return (
                    <Field key={field.key} label={field.label} span2={field.span2}>
                      <input type="number" min="0" step={field.step || '1'} className={inp}
                        value={form[field.key] ?? ''} onChange={e => change(field.key, parseFloat(e.target.value) || 0)} />
                    </Field>
                  )
                }
                return (
                  <Field key={field.key} label={field.label} span2={field.span2}>
                    <input className={inp} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)} />
                  </Field>
                )
              })}
            </div>
          </div>
        )}

        {tab === 'mouvements' && (
          <DataTable
            table="product_movements"
            columns={MOVEMENT_COLUMNS}
            data={product.movements || []}
            searchFields={['type', 'reason', 'user_name', 'reference_id']}
            height={embedded ? 'calc(100vh - 420px)' : 'calc(100vh - 360px)'}
          />
        )}

        {tab === 'bom' && (
          <div>
            {bom.length > 0 && <BomBuildableBanner summary={bomSummary} />}
            <DataTable
              table="bom_items"
              columns={BOM_COLUMNS}
              data={bomSummary.rows}
              searchFields={['component_name', 'component_sku', 'ref_des']}
              height={embedded ? 'calc(100vh - 480px)' : 'calc(100vh - 420px)'}
            />
          </div>
        )}

        {tab === 'docs' && (() => {
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
                  const urls = (product[f.url] || '').split(',').map(s => s.trim()).filter(Boolean)
                  const locals = (product[f.local] || '').split(',').map(s => s.trim()).filter(Boolean)
                  return (
                    <Field key={f.url} label={f.label} span2>
                      {urls.length === 0 ? (
                        <div className={`${inp} bg-slate-50 text-slate-400 italic cursor-default`}>—</div>
                      ) : (
                        <div className="space-y-3">
                          {urls.map((url, i) => {
                            const localPath = locals[i] || null
                            const localFilename = localPath ? localPath.replace(/^products\/docs\//, '') : null
                            const localUrl = localFilename ? `/erp/api/product-docs/${localFilename}` : null
                            return (
                              <div key={i} className="space-y-1.5">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`${inp} inline-flex items-center gap-1.5 text-brand-600 hover:underline truncate`}
                                  title={url}
                                >
                                  <ExternalLink size={14} className="shrink-0" />
                                  <span className="truncate">{urls.length > 1 ? `[${i + 1}] ` : ''}{url}</span>
                                </a>
                                {localUrl ? (
                                  <a
                                    href={localUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-xs text-emerald-700 hover:underline"
                                    title="Copie locale sur le serveur"
                                  >
                                    <Download size={12} /> Copie locale ({localFilename})
                                  </a>
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

      </div>

      <PurchaseOrderModal
        productId={id}
        isOpen={showPoModal}
        onClose={() => setShowPoModal(false)}
      />

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
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-lg font-semibold text-slate-900 mb-1">Mettre à jour les PDFs ?</h2>
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
                  onClick={() => { setShowRefreshDocsModal(false); setRefreshDocsResult(null); }}
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
            </div>
          </div>
        )
      })()}
    </>
  )
}
