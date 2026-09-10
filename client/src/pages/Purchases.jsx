import { useMemo } from 'react'
import { ShoppingCart, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import PurchaseDetail from './PurchaseDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

// Plus de rendu sur mesure : la seule colonne native restante (emplacement)
// s'affiche telle quelle. Tout le reste de la description d'un achat vient des
// champs personnalisés, que DataTable rend lui-même.
const COLUMNS = TABLE_COLUMN_META.purchases.map(meta => ({ ...meta }))

// Champs proposés par le formulaire « Nouvel achat » — exactement ceux que
// POST /api/purchases sait persister. Produit, référence, dates, quantité
// commandée et prix unitaire n'existent plus en colonne (migration 035), la
// quantité reçue non plus (036) : ils se saisissent, s'il y a lieu, dans les
// champs personnalisés de la fiche.
function purchaseFormFields({ companies }) {
  return [
    {
      field: 'supplier_company_id', label: 'Fournisseur', span: 2,
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
    { field: 'emplacement', label: 'Emplacement' },
  ]
}

export default function Purchases() {
  const navigate = useNavigate()
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const { rows: purchasesRaw, loading, reload } = useListData({ table: 'purchases' })
  const companies = useTable('companies')

  const purchases = useMemo(() => {
    const cById = new Map(companies.map(c => [c.id, c.name]))
    return purchasesRaw.map(r => ({
      ...r,
      supplier_company_name: cById.get(r.supplier_company_id) || r.supplier_company_name,
    }))
  }, [purchasesRaw, companies])

  const formFields = useMemo(() => purchaseFormFields({ companies }), [companies])

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
            title: row => row.at_id || `Achat #${row.id}`,
            subtitle: row => row.supplier_company_name || row.supplier_vendor_name || '',
            to: row => `/purchases/${row.id}`,
            width: 680,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <PurchaseDetail recordId={row.id} embedded onClose={close} /> }}
          searchFields={['at_id', 'supplier_company_name', 'supplier_vendor_name']}
          emptyState={{ icon: ShoppingCart, title: 'Aucun achat', description: "Aucune ligne d'achat n'est enregistrée. Les achats de produits apparaissent ici une fois saisis.", cta: { label: 'Nouvel achat', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
