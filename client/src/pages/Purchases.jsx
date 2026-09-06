import { useMemo } from 'react'
import { ShoppingCart, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge, PURCHASE_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import TableThumb from '../components/TableThumb.jsx'
import PurchaseDetail from './PurchaseDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

import { fmtCad } from '../utils/formatters.js'


const RENDERS = {
  image: row => row.product_image
    ? <TableThumb src={row.product_image} className="border border-slate-200" />
    : <span className="text-slate-300">—</span>,
  product_name: row => <div className="font-medium text-slate-900">{row.product_name || '—'}</div>,
  sku: row => row.sku ? <span className="text-slate-500 font-mono">{row.sku}</span> : null,
  supplier: row => {
    if (row.supplier_company_id && row.supplier_company_name) {
      return (
        <Link
          to={`/companies/${row.supplier_company_id}`}
          onClick={e => e.stopPropagation()}
          className="text-brand-600 hover:underline"
        >
          {row.supplier_company_name}
        </Link>
      )
    }
    return <span className="text-slate-500">{row.supplier || '—'}</span>
  },
  status: row => <Badge color={STATUS_COLORS[row.status] || 'gray'}>{row.status}</Badge>,
  unit_cost: row => <span className="text-slate-500">{row.unit_cost ? fmtCad(row.unit_cost) : '—'}</span>,
  order_date: row => <span className="text-slate-500">{fmtDate(row.order_date)}</span>,
}

const COLUMNS = TABLE_COLUMN_META.purchases.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const productLabel = p => [p.sku, p.name_fr || p.name_en].filter(Boolean).join(' — ') || p.id

const STATUS_OPTIONS = ['Commandé', 'Reçu partiellement', 'Reçu', 'Annulé']

// Champs proposés par le formulaire « Nouvel achat » — exactement ceux que
// POST /api/purchases sait persister. Produit et quantité sont verrouillés :
// la route les exige. Le reste a un défaut serveur (fournisseur et coût du
// produit, référence LIA-ERP-n, date du jour, statut « Commandé »).
function purchaseFormFields({ products, companies }) {
  return [
    {
      field: 'product_id', label: 'Produit', span: 2, locked: true, required: true,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="purchase_product_id"
          value={value}
          options={products}
          labelFn={productLabel}
          getHref={p => `/products/${p.id}`}
          onChange={onChange}
        />
      ),
    },
    { field: 'qty_ordered', label: 'Qté commandée', type: 'number', min: 1, locked: true, required: true },
    { field: 'unit_cost', label: 'Coût unitaire', type: 'currency' },
    {
      field: 'supplier_company_id', label: 'Fournisseur',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="purchase_supplier_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          onChange={onChange}
        />
      ),
    },
    { field: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    // Masqués par défaut — disponibles via « Modifier le formulaire ».
    { field: 'reference', label: 'Référence PO', visible: false },
    { field: 'status', label: 'Statut', type: 'select', options: STATUS_OPTIONS, visible: false },
    { field: 'order_date', label: 'Date commande', type: 'date', visible: false },
    { field: 'received_date', label: 'Date réception', type: 'date', visible: false },
    { field: 'emplacement', label: 'Emplacement', visible: false },
  ]
}

export default function Purchases() {
  const navigate = useNavigate()
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const { rows: purchasesRaw, loading, reload } = useListData({ table: 'purchases' })
  const products = useTable('products')
  const companies = useTable('companies')

  const purchases = useMemo(() => {
    const pById = new Map(products.map(p => [p.id, p]))
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return purchasesRaw.map(r => {
      const p = r.product_id ? pById.get(r.product_id) : null
      return {
        ...r,
        product_name: p?.name_fr || p?.name_en || r.product_name,
        sku: p?.sku || r.sku,
        product_image: p?.image_url || r.product_image,
        supplier_company_name: cById.get(r.supplier_company_id) || r.supplier_company_name,
      }
    })
  }, [purchasesRaw, products, companies])

  const formFields = useMemo(() => purchaseFormFields({ products, companies }), [products, companies])

  async function handleCreate(form) {
    const created = await api.purchases.create(form)
    await reload()
    if (created?.id) navigate(`/purchases/${created.id}`)
  }

  return (
    <ListPage
      title="Achats"
      create={{
        label: 'Nouvel achat', table: 'purchases', fields: formFields, columns: 2, size: 'lg',
        onSubmit: handleCreate,
      }}
    >
      {({ openCreate }) => (
        <DataTable
          table="purchases"
          manageViews
          columns={COLUMNS}
          data={purchases}
          loading={loading}
          peek={{
            title: row => row.product_name || row.reference || `Achat #${row.id}`,
            subtitle: row => row.supplier_company_name || row.supplier || '',
            to: row => `/purchases/${row.id}`,
            width: 680,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <PurchaseDetail recordId={row.id} embedded onClose={close} /> }}
          searchFields={['product_name', 'supplier', 'supplier_company_name', 'reference']}
          emptyState={{ icon: ShoppingCart, title: 'Aucun achat', description: "Aucune ligne d'achat n'est enregistrée. Les achats de produits apparaissent ici une fois saisis.", cta: { label: 'Nouvel achat', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
