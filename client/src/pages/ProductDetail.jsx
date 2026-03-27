import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, stockStatusColor, stockStatusLabel } from '../components/Badge.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']
const movTypeColor = { in: 'green', out: 'red', adjustment: 'blue' }
const movTypeLabel = { in: 'Entrée', out: 'Sortie', adjustment: 'Ajustement' }

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
  const [product, setProduct] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('info')
  const [form, setForm] = useState({})
  const [bom, setBom] = useState([])
  const saveTimer = useRef(null)

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
        supplier: data.supplier || '',
        procurement_type: data.procurement_type || '',
        weight_lbs: data.weight_lbs ?? 0,
        notes: data.notes || '',
        active: data.active === 1,
      })
    } finally {
      setLoading(false)
    }
  }

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

  const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-indigo-400 bg-white'

  if (loading) return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
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
                tab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
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

              <Field label="SKU">
                <input className={inp} value={form.sku} onChange={e => change('sku', e.target.value)} />
              </Field>
              <Field label="Type">
                <input className={inp} value={form.type} onChange={e => change('type', e.target.value)} />
              </Field>

              <Field label="Nom (FR)" span2>
                <input className={inp} value={form.name_fr} onChange={e => change('name_fr', e.target.value)} />
              </Field>
              <Field label="Nom (EN)" span2>
                <input className={inp} value={form.name_en} onChange={e => change('name_en', e.target.value)} />
              </Field>

              <Field label="Coût unitaire (CAD)">
                <input type="number" min="0" step="0.01" className={inp} value={form.unit_cost} onChange={e => change('unit_cost', parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Prix CAD">
                <input type="number" min="0" step="0.01" className={inp} value={form.price_cad} onChange={e => change('price_cad', parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Prix USD">
                <input type="number" min="0" step="0.01" className={inp} value={form.price_usd} onChange={e => change('price_usd', parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Prix mensuel CAD">
                <input type="number" min="0" step="0.01" className={inp} value={form.monthly_price_cad} onChange={e => change('monthly_price_cad', parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Prix mensuel USD">
                <input type="number" min="0" step="0.01" className={inp} value={form.monthly_price_usd} onChange={e => change('monthly_price_usd', parseFloat(e.target.value) || 0)} />
              </Field>

              <Field label="Stock actuel">
                <div className={`${inp} bg-slate-50 cursor-default`}>{product.stock_qty ?? 0}</div>
              </Field>
              <Field label="Stock minimum">
                <input type="number" min="0" className={inp} value={form.min_stock} onChange={e => change('min_stock', parseInt(e.target.value) || 0)} />
              </Field>
              <Field label="Qté à commander">
                <input type="number" min="0" className={inp} value={form.order_qty} onChange={e => change('order_qty', parseInt(e.target.value) || 0)} />
              </Field>

              <Field label="Fournisseur">
                <input className={inp} value={form.supplier} onChange={e => change('supplier', e.target.value)} />
              </Field>
              <Field label="Approvisionnement">
                <select className={inp} value={form.procurement_type} onChange={e => change('procurement_type', e.target.value)}>
                  <option value="">—</option>
                  {PROCUREMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>

              <Field label="Poids (lbs)">
                <input type="number" min="0" step="0.01" className={inp} value={form.weight_lbs} onChange={e => change('weight_lbs', parseFloat(e.target.value) || 0)} />
              </Field>

              <Field label="Notes" span2>
                <textarea className={inp} rows={3} value={form.notes} onChange={e => change('notes', e.target.value)} />
              </Field>

              <div className="col-span-2 flex gap-6 pt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" className="rounded" checked={form.is_sellable} onChange={e => change('is_sellable', e.target.checked)} />
                  <span className="text-sm text-slate-700">Vendable (soumissions / factures)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" className="rounded" checked={form.active} onChange={e => change('active', e.target.checked)} />
                  <span className="text-sm text-slate-700">Produit actif</span>
                </label>
              </div>

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
                      <td className="px-4 py-3 text-slate-500 text-xs">{fmtDate(m.created_at)}</td>
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
          <div className="card overflow-hidden">
            {!bom.length ? (
              <p className="text-center py-10 text-slate-400">Aucun composant BOM pour ce produit.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Composant</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500">Qté requise</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Ref. des.</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map((b, i) => (
                    <tr key={b.id || i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{b.component_name || '—'}</div>
                        {b.component_sku && <div className="text-xs text-slate-400 font-mono">{b.component_sku}</div>}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-slate-900">{b.qty_required ?? '—'}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-slate-500 text-xs">{b.reference_designator || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

      </div>
    </Layout>
  )
}
