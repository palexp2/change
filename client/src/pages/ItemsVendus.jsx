import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'

// Stripe stocke les montants en cents — on convertit en dollars pour l'affichage.
function fmtMoney(cents, currency) {
  if (cents == null) return '—'
  const value = cents / 100
  const curr = (currency || 'CAD').toUpperCase()
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: curr }).format(value)
  } catch {
    return `${value.toFixed(2)} ${curr}`
  }
}

export default function ItemsVendus() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState([])
  const [savingId, setSavingId] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.stripeInvoiceItems.list({ limit, page }),
      setItems, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.products.list({ limit: 'all', active: 'true' })
      .then(r => setProducts(r.data || []))
      .catch(() => {})
  }, [])

  const handleProductChange = useCallback(async (itemId, productId) => {
    setSavingId(itemId)
    try {
      const updated = await api.stripeInvoiceItems.update(itemId, { product_id: productId || null })
      setItems(prev => prev.map(it => (it.id === itemId ? { ...it, ...updated } : it)))
    } catch (err) {
      alert('Échec de la mise à jour : ' + (err.message || 'erreur inconnue'))
    } finally {
      setSavingId(null)
    }
  }, [])

  const COLUMNS = useMemo(() => {
    const RENDERS = {
      description: row => <span className="text-slate-700">{row.description || '—'}</span>,
      quantity:    row => <span className="text-slate-700">{row.quantity ?? '—'}</span>,
      unit_amount: row => <span className="text-slate-700">{fmtMoney(row.unit_amount, row.currency)}</span>,
      amount:      row => <span className="font-medium text-slate-700">{fmtMoney(row.amount, row.currency)}</span>,
      currency:    row => <span className="font-mono text-xs text-slate-600">{row.currency || '—'}</span>,
      facture_document_number: row => row.facture_id
        ? <Link to={`/factures/${row.facture_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.facture_document_number || row.facture_invoice_id || row.facture_id}</Link>
        : <span className="text-slate-400">—</span>,
      stripe_price_id:   row => row.stripe_price_id ? <span className="font-mono text-xs text-slate-500">{row.stripe_price_id}</span> : <span className="text-slate-400">—</span>,
      stripe_product_id: row => row.stripe_product_id ? <span className="font-mono text-xs text-slate-500">{row.stripe_product_id}</span> : <span className="text-slate-400">—</span>,
      stripe_invoice_id: row => row.stripe_invoice_id ? <span className="font-mono text-xs text-slate-500">{row.stripe_invoice_id}</span> : <span className="text-slate-400">—</span>,
      period_start: row => <span className="text-slate-500">{fmtDate(row.period_start)}</span>,
      period_end:   row => <span className="text-slate-500">{fmtDate(row.period_end)}</span>,
      proration:    row => <span className={row.proration ? 'text-slate-700' : 'text-slate-400'}>{row.proration ? 'Oui' : 'Non'}</span>,
      created_at:   row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
      product_id: row => (
        <div onClick={e => e.stopPropagation()}>
          <LinkedRecordField
            name={`product-${row.id}`}
            value={row.product_id}
            options={products}
            labelFn={p => `${p.name_fr || p.name_en || '?'}${p.sku ? ` (${p.sku})` : ''}`}
            getHref={p => `/products/${p.id}`}
            placeholder="Lier un produit"
            saving={savingId === row.id}
            onChange={newId => handleProductChange(row.id, newId)}
          />
        </div>
      ),
    }
    return TABLE_COLUMN_META.stripe_invoice_items.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
  }, [products, savingId, handleProductChange])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Items vendus</h1>
            <p className="text-sm text-slate-500 mt-1">Lignes des factures Stripe — lie chaque item à un produit ERP.</p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="stripe_invoice_items" />
          </div>
        </div>

        <DataTable
          table="stripe_invoice_items"
          columns={COLUMNS}
          data={items}
          searchFields={['description', 'stripe_price_id', 'stripe_product_id', 'facture_document_number']}
          loading={loading}
        />
      </div>
    </Layout>
  )
}
