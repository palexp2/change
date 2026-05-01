import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']

function ProductForm({ initial = {}, onSave, onClose }) {
  const [form, setForm] = useState({
    sku: '', name_fr: '', name_en: '', type: '', unit_cost: '', price_cad: '',
    stock_qty: 0, min_stock: 0, order_qty: 0, supplier: '', procurement_type: '',
    weight_lbs: '', notes: '', active: true, ...initial
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">SKU</label>
          <input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} className="input" placeholder="ABC-001" />
        </div>
        <div>
          <label className="label">Type</label>
          <input value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="input" placeholder="Capteur, Valve..." />
        </div>
        <div className="col-span-2">
          <label className="label">Nom (FR) *</label>
          <input value={form.name_fr} onChange={e => setForm(f => ({ ...f, name_fr: e.target.value }))} className="input" required />
        </div>
        <div className="col-span-2">
          <label className="label">Nom (EN)</label>
          <input value={form.name_en} onChange={e => setForm(f => ({ ...f, name_en: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Coût unitaire (CAD)</label>
          <input type="number" min="0" step="0.01" value={form.unit_cost} onChange={e => setForm(f => ({ ...f, unit_cost: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Prix de vente (CAD)</label>
          <input type="number" min="0" step="0.01" value={form.price_cad} onChange={e => setForm(f => ({ ...f, price_cad: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Qté en stock</label>
          <input type="number" min="0" value={form.stock_qty} onChange={e => setForm(f => ({ ...f, stock_qty: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Stock minimum</label>
          <input type="number" min="0" value={form.min_stock} onChange={e => setForm(f => ({ ...f, min_stock: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Qté à commander</label>
          <input type="number" min="0" value={form.order_qty} onChange={e => setForm(f => ({ ...f, order_qty: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Fournisseur</label>
          <input value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Approvisionnement</label>
          <select value={form.procurement_type} onChange={e => setForm(f => ({ ...f, procurement_type: e.target.value }))} className="select">
            <option value="">—</option>
            {PROCUREMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Poids (lbs)</label>
          <input type="number" min="0" step="0.01" value={form.weight_lbs} onChange={e => setForm(f => ({ ...f, weight_lbs: e.target.value }))} className="input" />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={3} />
        </div>
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

function StockAdjustModal({ product, onSave, onClose }) {
  const [form, setForm] = useState({ type: 'in', qty: '', reason: '' })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.products.adjustStock(product.id, { ...form, qty: parseInt(form.qty) })
      onSave()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-slate-50 rounded-lg p-3 text-sm">
        <div className="font-medium">{product.name_fr}</div>
        <div className="text-slate-500">Stock actuel: <strong>{product.stock_qty}</strong></div>
      </div>
      <div>
        <label className="label">Type de mouvement</label>
        <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
          <option value="in">Entrée (+)</option>
          <option value="out">Sortie (-)</option>
          <option value="adjustment">Ajustement (= valeur exacte)</option>
        </select>
      </div>
      <div>
        <label className="label">Quantité *</label>
        <input type="number" min="0" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">Raison</label>
        <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="input" placeholder="Réception commande, inventaire..." />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? '...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function Products() {
  const navigate = useNavigate()
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [stockProduct, setStockProduct] = useState(null)
  const undoableDelete = useUndoableDelete()

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.products.list({ limit, page, active: true }),
      setProducts, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.products, [])

  async function handleCreate(form) {
    await api.products.create(form)
    load()
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Inventaire</h1>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="products" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau produit
            </button>
          </div>
        </div>

        <DataTable
          table="products"
          columns={COLUMNS}
          data={products}
          loading={loading}
          onRowClick={row => navigate(`/products/${row.id}`)}
          searchFields={['name_fr', 'name_en', 'sku', 'supplier']}
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'products',
              ids,
              deleteFn: () => Promise.all(ids.map(id => api.products.delete(id))),
              label: `${ids.length} produit${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`,
              onChange: load,
            })
          }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau produit" size="lg">
        <ProductForm onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <Modal isOpen={!!stockProduct} onClose={() => setStockProduct(null)} title="Ajustement de stock" size="sm">
        {stockProduct && (
          <StockAdjustModal
            product={stockProduct}
            onSave={() => { load(); setStockProduct(null) }}
            onClose={() => setStockProduct(null)}
          />
        )}
      </Modal>
    </Layout>
  )
}
