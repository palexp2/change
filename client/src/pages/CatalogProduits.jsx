import { useState, useEffect } from 'react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Plus, Pencil, Check, X } from 'lucide-react'

function fmt(n, currency) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

const EMPTY_FORM = { name_fr: '', name_en: '', unit_price_cad: 0, price_usd: 0, monthly_price_cad: 0, monthly_price_usd: 0 }

function PriceInput({ value, onChange }) {
  return (
    <input
      type="number" min="0" step="0.01"
      className="w-full border rounded px-2 py-1 text-sm text-right"
      value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

function ProductRow({ product, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    name_fr: product.name_fr,
    name_en: product.name_en,
    unit_price_cad: product.unit_price_cad ?? 0,
    price_usd: product.price_usd ?? 0,
    monthly_price_cad: product.monthly_price_cad ?? 0,
    monthly_price_usd: product.monthly_price_usd ?? 0,
  })
  const [saving, setSaving] = useState(false)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const save = async () => {
    setSaving(true)
    try {
      await api.catalog.update(product.id, form)
      onSaved()
      setEditing(false)
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <tr className="bg-indigo-50">
        <td className="px-3 py-2">
          <input className="w-full border rounded px-2 py-1 text-sm mb-1" value={form.name_fr}
            onChange={e => set('name_fr', e.target.value)} placeholder="Nom FR" />
          <input className="w-full border rounded px-2 py-1 text-sm" value={form.name_en}
            onChange={e => set('name_en', e.target.value)} placeholder="Name EN" />
        </td>
        <td className="px-3 py-2"><PriceInput value={form.unit_price_cad} onChange={v => set('unit_price_cad', v)} /></td>
        <td className="px-3 py-2"><PriceInput value={form.price_usd} onChange={v => set('price_usd', v)} /></td>
        <td className="px-3 py-2"><PriceInput value={form.monthly_price_cad} onChange={v => set('monthly_price_cad', v)} /></td>
        <td className="px-3 py-2"><PriceInput value={form.monthly_price_usd} onChange={v => set('monthly_price_usd', v)} /></td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          <button onClick={save} disabled={saving} className="text-indigo-600 hover:text-indigo-800 mr-2"><Check size={16} /></button>
          <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b hover:bg-slate-50">
      <td className="px-3 py-3">
        <div className="font-medium text-slate-900">{product.name_fr}</div>
        <div className="text-xs text-slate-500">{product.name_en}</div>
      </td>
      <td className="px-3 py-3 text-right font-mono text-sm text-slate-800">{fmt(product.unit_price_cad, 'CAD')}</td>
      <td className="px-3 py-3 text-right font-mono text-sm text-slate-800">{fmt(product.price_usd, 'USD')}</td>
      <td className="px-3 py-3 text-right font-mono text-sm text-slate-800">{fmt(product.monthly_price_cad, 'CAD')}</td>
      <td className="px-3 py-3 text-right font-mono text-sm text-slate-800">{fmt(product.monthly_price_usd, 'USD')}</td>
      <td className="px-3 py-3 text-right">
        <button onClick={() => setEditing(true)} className="text-slate-400 hover:text-indigo-600"><Pencil size={15} /></button>
      </td>
    </tr>
  )
}

function AddRow({ onAdd, onCancel, sortOrder }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const save = async () => {
    if (!form.name_fr || !form.name_en) return
    setSaving(true)
    try {
      await api.catalog.create({ ...form, sort_order: sortOrder })
      onAdd()
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="bg-indigo-50 border-b">
      <td className="px-3 py-2">
        <input className="w-full border rounded px-2 py-1 text-sm mb-1" value={form.name_fr}
          onChange={e => set('name_fr', e.target.value)} placeholder="Nom FR *" />
        <input className="w-full border rounded px-2 py-1 text-sm" value={form.name_en}
          onChange={e => set('name_en', e.target.value)} placeholder="Name EN *" />
      </td>
      <td className="px-3 py-2"><PriceInput value={form.unit_price_cad} onChange={v => set('unit_price_cad', v)} /></td>
      <td className="px-3 py-2"><PriceInput value={form.price_usd} onChange={v => set('price_usd', v)} /></td>
      <td className="px-3 py-2"><PriceInput value={form.monthly_price_cad} onChange={v => set('monthly_price_cad', v)} /></td>
      <td className="px-3 py-2"><PriceInput value={form.monthly_price_usd} onChange={v => set('monthly_price_usd', v)} /></td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button onClick={save} disabled={saving} className="text-indigo-600 hover:text-indigo-800 mr-2"><Check size={16} /></button>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </td>
    </tr>
  )
}

export default function CatalogProduits() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    try { setProducts(await api.catalog.list()) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Catalogue de produits</h1>
            <p className="text-sm text-slate-500 mt-1">Produits et services disponibles pour les soumissions et factures</p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
          >
            <Plus size={16} /> Ajouter un produit
          </button>
        </div>

        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b">
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Produit</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Prix CAD</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Prix USD</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Mensuel CAD</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Mensuel USD</th>
                <th className="px-3 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Chargement…</td></tr>
              ) : products.length === 0 && !adding ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Aucun produit</td></tr>
              ) : (
                products.map(p => <ProductRow key={p.id} product={p} onSaved={load} />)
              )}
              {adding && (
                <AddRow sortOrder={products.length} onAdd={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
