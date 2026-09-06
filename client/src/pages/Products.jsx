import { useState, useMemo } from 'react'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { Plus, Package } from 'lucide-react'
import api from '../lib/api.js'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import TableThumb from '../components/TableThumb.jsx'
import ProductDetail from './ProductDetail.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']

// Champs proposés par le formulaire « Nouveau produit » — liste calquée sur ce
// que POST /api/products persiste (voir RecordForm.jsx pour la configuration).
const PRODUCT_FORM_FIELDS = [
  { field: 'sku', label: 'SKU' },
  { field: 'type', label: 'Type' },
  { field: 'name_fr', label: 'Nom (FR)', span: 2, locked: true, required: true },
  { field: 'name_en', label: 'Nom (EN)', span: 2 },
  { field: 'unit_cost', label: 'Coût unitaire (CAD)', type: 'currency', min: '0' },
  { field: 'price_cad', label: 'Prix de vente (CAD)', type: 'currency', min: '0' },
  { field: 'stock_qty', label: 'Qté en stock', type: 'number', min: '0', defaultValue: 0 },
  { field: 'min_stock', label: 'Stock minimum', type: 'number', min: '0', defaultValue: 0 },
  { field: 'order_qty', label: 'Qté à commander', type: 'number', min: '0', defaultValue: 0 },
  { field: 'supplier', label: 'Fournisseur' },
  { field: 'procurement_type', label: 'Approvisionnement', type: 'select', options: PROCUREMENT_TYPES },
  { field: 'weight_lbs', label: 'Poids (lbs)', type: 'number', min: '0', step: '0.01' },
  { field: 'notes', label: 'Notes', type: 'textarea', span: 2 },
]

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
        <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="input" />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? '...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

export default function Products() {
  const [showModal, setShowModal] = useState(false)
  const [stockProduct, setStockProduct] = useState(null)
  const undoableDelete = useUndoableDelete()
  const { addToast } = useToast()

  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

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
            ? <TableThumb src={row.image_url} className="border border-slate-200" />
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
            <PageTitle>Inventaire</PageTitle>
          </div>
          <div className="flex items-center gap-2">
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
          peek={{
            title: row => row.name_fr || row.name_en || 'Produit',
            subtitle: row => [row.sku, row.type].filter(Boolean).join(' · '),
            to: row => `/products/${row.id}`,
            width: 720,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <ProductDetail recordId={row.id} embedded onClose={close} /> }}
          searchFields={['name_fr', 'name_en', 'sku', 'supplier']}
          onBulkDelete={async (ids) => {
            // Le serveur refuse (409) toute pièce citée par un BOM, un envoi ou
            // un achat : on supprime ce qui peut l'être et on signale le reste,
            // au lieu de tout perdre sur le premier refus.
            const results = await Promise.allSettled(ids.map(id => api.products.delete(id)))
            const done = ids.filter((_, i) => results[i].status === 'fulfilled')
            const blocked = ids.length - done.length
            if (done.length) {
              await undoableDelete({
                table: 'products',
                ids: done,
                deleteFn: () => Promise.resolve(), // déjà supprimé ci-dessus
                label: `${done.length} produit${done.length > 1 ? 's' : ''} supprimé${done.length > 1 ? 's' : ''}`,
                onChange: syncStore,
              })
            }
            if (blocked) {
              addToast({
                type: 'error',
                duration: 6000,
                message: `${blocked} pièce${blocked > 1 ? 's' : ''} liée${blocked > 1 ? 's' : ''} à un BOM, un envoi ou un achat — conservée${blocked > 1 ? 's' : ''}`,
              })
            }
          }}
          emptyState={{ icon: Package, title: 'Aucun produit', description: "Aucun produit n'est encore au catalogue. Ajoute un produit pour le vendre et l'assembler.", cta: { label: 'Nouveau produit', icon: Plus, onClick: () => setShowModal(true) } }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau produit" size="lg">
        <RecordForm
          table="products"
          fields={PRODUCT_FORM_FIELDS}
          columns={2}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
        />
      </Modal>


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
