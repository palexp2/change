import { useState, useEffect } from 'react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Plus } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmt(n, currency) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

const EMPTY_FORM = { name_fr: '', name_en: '', unit_price_cad: 0, price_usd: 0, monthly_price_cad: 0, monthly_price_usd: 0 }

const RENDERS = {
  name_fr: row => <span className="font-medium text-slate-900">{row.name_fr}</span>,
  name_en: row => <span className="text-slate-600">{row.name_en}</span>,
  unit_price_cad:    row => <span className="font-mono text-sm">{fmt(row.unit_price_cad, 'CAD')}</span>,
  price_usd:         row => <span className="font-mono text-sm">{fmt(row.price_usd, 'USD')}</span>,
  monthly_price_cad: row => <span className="font-mono text-sm">{fmt(row.monthly_price_cad, 'CAD')}</span>,
  monthly_price_usd: row => <span className="font-mono text-sm">{fmt(row.monthly_price_usd, 'USD')}</span>,
}

const COLUMNS = TABLE_COLUMN_META.catalog.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function PriceInput({ value, onChange, onBlur }) {
  return (
    <input
      type="number" min="0" step="0.01"
      className="w-full border rounded px-2 py-1.5 text-sm text-right"
      value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      onBlur={onBlur}
    />
  )
}

function EditProductModal({ product, onClose, onSaved }) {
  const isEdit = !!product
  const [form, setForm] = useState(isEdit ? {
    name_fr: product.name_fr,
    name_en: product.name_en,
    unit_price_cad: product.unit_price_cad ?? 0,
    price_usd: product.price_usd ?? 0,
    monthly_price_cad: product.monthly_price_cad ?? 0,
    monthly_price_usd: product.monthly_price_usd ?? 0,
  } : EMPTY_FORM)
  const [saving, setSaving] = useState({})
  const [error, setError] = useState('')

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  async function saveField(key, value) {
    if (!isEdit) return
    setSaving(s => ({ ...s, [key]: true }))
    try {
      await api.catalog.update(product.id, { ...form, [key]: value })
      onSaved()
    } catch (e) { setError(e.message) }
    finally { setSaving(s => ({ ...s, [key]: false })) }
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!form.name_fr || !form.name_en) { setError('Nom FR et EN requis'); return }
    setError('')
    try {
      await api.catalog.create(form)
      onSaved()
      onClose()
    } catch (e) { setError(e.message) }
  }

  const savingIndicator = (k) => saving[k] ? <span className="text-xs text-slate-400 ml-1">(sauvegarde...)</span> : null

  const fields = (
    <>
      <div>
        <label className="label">Nom FR{savingIndicator('name_fr')}</label>
        <input className="input" value={form.name_fr}
          onChange={e => set('name_fr', e.target.value)}
          onBlur={e => saveField('name_fr', e.target.value)} placeholder="Nom FR" />
      </div>
      <div>
        <label className="label">Name EN{savingIndicator('name_en')}</label>
        <input className="input" value={form.name_en}
          onChange={e => set('name_en', e.target.value)}
          onBlur={e => saveField('name_en', e.target.value)} placeholder="Name EN" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Prix CAD{savingIndicator('unit_price_cad')}</label>
          <PriceInput value={form.unit_price_cad}
            onChange={v => set('unit_price_cad', v)}
            onBlur={() => saveField('unit_price_cad', form.unit_price_cad)} />
        </div>
        <div>
          <label className="label">Prix USD{savingIndicator('price_usd')}</label>
          <PriceInput value={form.price_usd}
            onChange={v => set('price_usd', v)}
            onBlur={() => saveField('price_usd', form.price_usd)} />
        </div>
        <div>
          <label className="label">Mensuel CAD{savingIndicator('monthly_price_cad')}</label>
          <PriceInput value={form.monthly_price_cad}
            onChange={v => set('monthly_price_cad', v)}
            onBlur={() => saveField('monthly_price_cad', form.monthly_price_cad)} />
        </div>
        <div>
          <label className="label">Mensuel USD{savingIndicator('monthly_price_usd')}</label>
          <PriceInput value={form.monthly_price_usd}
            onChange={v => set('monthly_price_usd', v)}
            onBlur={() => saveField('monthly_price_usd', form.monthly_price_usd)} />
        </div>
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </>
  )

  if (isEdit) {
    return (
      <div className="space-y-4">
        {fields}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="btn-primary">Fermer</button>
        </div>
      </div>
    )
  }
  return (
    <form onSubmit={handleCreate} className="space-y-4">
      {fields}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" className="btn-primary">Créer</button>
      </div>
    </form>
  )
}

export default function CatalogProduits() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // null | product | 'new'

  const load = async () => {
    try { setProducts(await api.catalog.list()) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  return (
    <Layout>
      <div className="px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Catalogue de produits</h1>
            <p className="text-sm text-slate-500 mt-1">Produits et services disponibles pour les soumissions et factures</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="catalog" />
            <button
              onClick={() => setEditing('new')}
              className="flex items-center gap-2 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700"
            >
              <Plus size={16} /> Ajouter un produit
            </button>
          </div>
        </div>

        <DataTable
          table="catalog"
          columns={COLUMNS}
          data={products}
          loading={loading}
          onRowClick={row => setEditing(row)}
          searchFields={['name_fr', 'name_en']}
        />

        <Modal
          isOpen={!!editing}
          onClose={() => setEditing(null)}
          title={editing === 'new' ? 'Nouveau produit' : 'Modifier le produit'}
        >
          {editing && (
            <EditProductModal
              product={editing === 'new' ? null : editing}
              onClose={() => setEditing(null)}
              onSaved={load}
            />
          )}
        </Modal>
      </div>
    </Layout>
  )
}
