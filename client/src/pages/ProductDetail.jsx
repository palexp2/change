import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FileText, ExternalLink } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, stockStatusColor, stockStatusLabel } from '../components/Badge.jsx'
import { VendorSelect } from '../components/VendorSelect.jsx'
import { PurchaseOrderModal } from '../components/PurchaseOrderModal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useAuth } from '../lib/auth.jsx'
import { fmtDateTime } from '../lib/formatDate.js'


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
      <img src={row.component_image_url} alt={row.component_name || ''}
        className="h-10 w-10 object-cover rounded border border-slate-200" loading="lazy" />
    ) : (
      <div className="h-10 w-10 rounded border border-dashed border-slate-200" />
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

function Field({ label, children, span2 = false }) {
  return (
    <div className={span2 ? 'col-span-2' : ''}>
      <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  )
}

export default function ProductDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user: _user } = useAuth()
  const [product, setProduct] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('info')
  const [form, setForm] = useState({})
  const [bom, setBom] = useState([])
  const [showPoModal, setShowPoModal] = useState(false)
  const saveTimer = useRef(null)
  const visibleFields = PRODUCT_FIELDS.filter(f => f.defaultVisible !== false)

  async function load() {
    setLoading(true)
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
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

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
      api.products.update(id, next).catch(console.error)
    }, 300)
  }

  const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

  if (loading) return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" /></div></Layout>
  if (!product) return <Layout><div className="p-6 text-slate-500">Produit introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/products')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          {product.image_url && (
            <img src={product.image_url} alt={form.name_fr} className="w-20 h-20 object-cover rounded-lg border border-slate-200 flex-shrink-0" />
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{form.name_fr || <span className="text-slate-400 italic font-normal">Sans nom</span>}</h1>
              <Badge color={stockStatusColor(product)} size="md">{stockStatusLabel(product)}</Badge>
              {!form.active && <Badge color="red">Inactif</Badge>}
              {form.is_sellable && <Badge color="indigo">Vendable</Badge>}
            </div>
            <div className="text-sm text-slate-500 mt-1 flex gap-3">
              {form.sku && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{form.sku}</span>}
              {form.type && <span>{form.type}</span>}
              <span>Stock: <strong>{product.stock_qty}</strong> / min: {form.min_stock || 0}</span>
            </div>
          </div>
          {form.buy_via_po && form.supplier_company_id && (
            <button
              onClick={() => setShowPoModal(true)}
              className="btn-primary flex items-center gap-1.5 text-sm"
            >
              <FileText size={14} /> Générer un PO
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-slate-200">
          {[
            { key: 'info', label: 'Informations' },
            { key: 'mouvements', label: 'Mouvements de stock' },
            { key: 'bom', label: 'BOM' },
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
                            api.products.update(id, next).catch(console.error)
                          }, 300)
                        }}
                      />
                    </Field>
                  )
                }
                if (field.type === 'select') {
                  return (
                    <Field key={field.key} label={field.label} span2={field.span2}>
                      <select className={inp} value={form[field.key] || ''} onChange={e => change(field.key, e.target.value)}>
                        <option value="">—</option>
                        {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
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
          <div className="card overflow-hidden">
            {!product.movements?.length ? (
              <p className="text-center py-10 text-slate-400">Aucun mouvement de stock</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Type</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Qté</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Raison</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Utilisateur</th>
                  </tr>
                </thead>
                <tbody>
                  {product.movements.map(m => (
                    <tr key={m.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-500 text-xs">{fmtDateTime(m.created_at)}</td>
                      <td className="px-4 py-3"><Badge color={movTypeColor[m.type]}>{movTypeLabel[m.type]}</Badge></td>
                      <td className={`px-4 py-3 text-right font-bold ${m.type === 'in' ? 'text-green-600' : m.type === 'out' ? 'text-red-600' : 'text-blue-600'}`}>
                        {m.type === 'in' ? '+' : m.type === 'out' ? '-' : '='}{m.qty}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{m.reason || '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-slate-500 text-xs">{m.user_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'bom' && (
          <DataTable
            table="bom_items"
            columns={BOM_COLUMNS}
            data={bom}
            searchFields={['component_name', 'component_sku', 'ref_des']}
            height="calc(100vh - 360px)"
          />
        )}

      </div>

      <PurchaseOrderModal
        productId={id}
        isOpen={showPoModal}
        onClose={() => setShowPoModal(false)}
      />
    </Layout>
  )
}
