import { useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

import { fmtMoney } from '../utils/formatters.js'


export default function ItemsVendus() {
  const { addToast } = useToast()
  const [savingId, setSavingId] = useState(null)

  const { rows: itemsRaw, loading, reload } = useListData({ table: 'stripe_invoice_items' })
  const factures = useTable('factures')
  const productsAll = useTable('products')

  const products = useMemo(() => productsAll.filter(p => p.active), [productsAll])

  const items = useMemo(() => {
    const fById = new Map(factures.map(f => [f.id, f]))
    return itemsRaw.map(r => {
      const f = r.facture_id ? fById.get(r.facture_id) : null
      return {
        ...r,
        facture_document_number: f?.document_number || r.facture_document_number,
        facture_invoice_id: f?.invoice_id || r.facture_invoice_id,
      }
    })
  }, [itemsRaw, factures])

  const handleProductChange = useCallback(async (itemId, productId) => {
    setSavingId(itemId)
    try {
      await api.stripeInvoiceItems.update(itemId, { product_id: productId || null })
      await reload()
    } catch (err) {
      addToast({ message: 'Échec de la mise à jour : ' + (err.message || 'erreur inconnue'), type: 'error' })
    } finally {
      setSavingId(null)
    }
  }, [addToast, reload])

  const COLUMNS = useMemo(() => {
    const RENDERS = {
      description: row => <span className="text-slate-700">{row.description || '—'}</span>,
      quantity:    row => <span className="text-slate-700">{row.quantity ?? '—'}</span>,
      unit_amount: row => <span className="text-slate-700">{fmtMoney(row.unit_amount, row.currency, { cents: true })}</span>,
      amount:      row => <span className="font-medium text-slate-700">{fmtMoney(row.amount, row.currency, { cents: true })}</span>,
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
            saving={savingId === row.id}
            onChange={newId => handleProductChange(row.id, newId)}
          />
        </div>
      ),
    }
    return TABLE_COLUMN_META.stripe_invoice_items.map(meta => ({ ...meta, render: RENDERS[meta.id] }))
  }, [products, savingId, handleProductChange])

  return (
    <ListPage
      title="Items vendus"
      subtitle={<p className="text-sm text-slate-500 mt-1">Lignes des factures Stripe — lie chaque item à un produit ERP.</p>}
    >
      <DataTable
        table="stripe_invoice_items"
        manageViews
        columns={COLUMNS}
        data={items}
        searchFields={['description', 'stripe_price_id', 'stripe_product_id', 'facture_document_number', 'amount', 'unit_amount']}
        loading={loading}
      />
    </ListPage>
  )
}
