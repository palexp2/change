import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Package, SlidersHorizontal } from 'lucide-react'
import api from '../lib/api.js'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { AirtableCoreMapModal } from '../components/AirtableCoreMapModal.jsx'
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
    // Trim des champs texte au submit pour éviter des records pollués par des espaces seuls.
    const trimmed = {
      ...form,
      sku: form.sku.trim(),
      name_fr: form.name_fr.trim(),
      name_en: form.name_en.trim(),
      type: form.type.trim(),
      supplier: form.supplier.trim(),
      notes: form.notes.trim(),
    }
    if (!trimmed.name_fr) {
      setError('Le nom (FR) est requis.')
      return
    }
    setSaving(true)
    try {
      await onSave(trimmed)
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
  const [showModal, setShowModal] = useState(false)
  const [airtableMapOpen, setAirtableMapOpen] = useState(false)
  const [stockProduct, setStockProduct] = useState(null)
  const undoableDelete = useUndoableDelete()

  // Cache global (lib/dataStore) : hydraté au login par /api/bootstrap, mis à
  // jour par delta polling toutes les 10s. La page filtre l'état "inactif"
  // côté client (l'ancien endpoint le faisait via ?active=true).
  const allProducts = useTable('products')
  const products = useMemo(() => allProducts.filter(p => p.active !== 0), [allProducts])
  const loading = !isTableHydrated('products')

  // Vignette pour la colonne Image — les colonnes hardcodées ne passent pas
  // par DynamicCell, le rendu custom vit ici (même pattern que Purchases).
  const COLUMNS = useMemo(() => TABLE_COLUMN_META.products.map(meta => (
    meta.id === 'image_url'
      ? {
          ...meta,
          render: row => row.image_url
            ? <img src={row.image_url} alt="" className="h-8 w-8 object-cover rounded border border-slate-200" loading="lazy" />
            : <span className="text-slate-300">—</span>,
        }
      : meta
  )), [])

  async function handleCreate(form) {
    await api.products.create(form)
    // Synchro immédiate pour voir le nouveau produit sans attendre le poll.
    await syncStore()
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Inventaire</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAirtableMapOpen(true)}
              className="btn-secondary btn-sm flex items-center gap-1.5"
              title="Choisir quels champs Airtable alimentent les produits"
              data-testid="products-airtable-map-open"
            >
              <SlidersHorizontal size={13} /> Sync Airtable
            </button>
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau produit
            </button>
          </div>
        </div>

        <DataTable
          table="products"
          manageViews
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
              onChange: syncStore,
            })
          }}
          emptyState={{ icon: Package, title: 'Aucun produit', description: "Aucun produit n'est encore au catalogue. Ajoute un produit pour le vendre et l'assembler.", cta: { label: 'Nouveau produit', icon: Plus, onClick: () => setShowModal(true) } }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau produit" size="lg">
        <ProductForm onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <AirtableCoreMapModal
        isOpen={airtableMapOpen}
        onClose={() => setAirtableMapOpen(false)}
        modules={[{ module: 'pieces', title: 'Produits' }]}
        title="Mapping des champs Airtable"
        onSaved={syncStore}
      />

      <Modal isOpen={!!stockProduct} onClose={() => setStockProduct(null)} title="Ajustement de stock" size="sm">
        {stockProduct && (
          <StockAdjustModal
            product={stockProduct}
            onSave={() => { syncStore(); setStockProduct(null) }}
            onClose={() => setStockProduct(null)}
          />
        )}
      </Modal>
    </Layout>
  )
}
