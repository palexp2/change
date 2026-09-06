import { useSearchParams } from 'react-router-dom'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { Plus, X, Building2 } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge, phaseBadgeColor } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import CompanyDetail from './CompanyDetail.jsx'

const TYPES = ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin',
  'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire',
  'Compétiteur', 'Consultant', 'Autre']

const PHASES = ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore']

const RENDERS = {
  name: row => <div className="font-medium text-slate-900">{row.name}</div>,
  city: row => row.city ? <span>{row.city}{row.province ? `, ${row.province}` : ''}</span> : null,
  lifecycle_phase: row => row.lifecycle_phase
    ? <Badge color={phaseBadgeColor(row.lifecycle_phase)}>{row.lifecycle_phase}</Badge>
    : <span className="text-slate-400">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.companies.map(meta => ({
  ...meta,
  render: RENDERS[meta.id],
}))

// Champs proposés par le formulaire « Nouvelle entreprise » — liste calquée sur
// ce que POST /api/companies persiste. Visibilité et obligation configurables
// par l'utilisateur (voir RecordForm.jsx).
const COMPANY_FORM_FIELDS = [
  { field: 'name', label: 'Nom', span: 2, locked: true, required: true },
  {
    field: 'type', label: 'Type', type: 'select', options: TYPES,
    searchable: true, testId: 'company-form-type',
  },
  {
    field: 'lifecycle_phase', label: 'Phase', type: 'select', options: PHASES,
    searchable: true, testId: 'company-form-phase',
  },
  { field: 'phone', label: 'Téléphone' },
  { field: 'email', label: 'Courriel', type: 'email' },
  { field: 'website', label: 'Site web', span: 2 },
  { field: 'address', label: 'Adresse', span: 2 },
  { field: 'city', label: 'Ville' },
  { field: 'province', label: 'Province' },
  { field: 'notes', label: 'Notes', type: 'textarea', span: 2 },
  // Masqués par défaut — disponibles via « Modifier le formulaire ».
  { field: 'country', label: 'Pays', visible: false, defaultValue: 'Canada' },
  { field: 'language', label: 'Langue', type: 'select', visible: false, options: [{ value: 'French', label: 'Français' }, { value: 'English', label: 'Anglais' }] },
  { field: 'currency', label: 'Devise', type: 'select', visible: false, options: ['CAD', 'USD'], defaultValue: 'CAD' },
]

export default function Companies() {
  const [searchParams, setSearchParams] = useSearchParams()
  const farmProvince = searchParams.get('farm_province') || ''
  const shippingProvince = searchParams.get('shipping_province') || ''
  const undoableDelete = useUndoableDelete()
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const filtered = !!(farmProvince || shippingProvince)
  const { rows: companies, loading, reload: load } = useListData({
    fetch: (page, limit) => api.companies.list({
      limit, page,
      ...(farmProvince ? { farm_province: farmProvince } : {}),
      ...(shippingProvince ? { shipping_province: shippingProvince } : {}),
    }),
    deps: [farmProvince, shippingProvince],
    // Vue filtrée par province : une création n'y a pas forcément sa place.
    realtime: { entity: 'company', channel: 'companies:list', predicate: () => !filtered },
  })

  async function handleCreate(form) {
    await api.companies.create(form)
    load()
  }

  const provinceChip = (label) => (
    <div className="flex items-center gap-2 mt-1">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1">
        {label}
        <button onClick={() => setSearchParams({})} className="hover:text-blue-900">
          <X size={12} />
        </button>
      </span>
    </div>
  )

  return (
    <ListPage
      title="Entreprises"
      subtitle={<>
        {farmProvince && provinceChip(`Ferme en ${farmProvince}`)}
        {shippingProvince && provinceChip(`Client — livraison en ${shippingProvince}`)}
      </>}
      create={{
        label: 'Nouvelle entreprise', table: 'companies', fields: COMPANY_FORM_FIELDS, columns: 2, size: 'lg',
        onSubmit: handleCreate,
        extra: values => <DuplicateWarning kind="company" values={values} />,
      }}
    >
      {({ openCreate }) => (
        <DataTable
          table="companies"
          manageViews
          columns={COLUMNS}
          data={companies}
          loading={loading}
          peek={{
            title: row => row.name || 'Entreprise',
            subtitle: row => [row.type, row.city].filter(Boolean).join(' · '),
            to: row => `/companies/${row.id}`,
            width: 720,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <CompanyDetail recordId={row.id} embedded onClose={close} /> }}
          searchFields={['name', 'email', 'city', 'phone']}
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'companies',
              ids,
              deleteFn: () => Promise.all(ids.map(id => api.companies.delete(id))),
              label: `${ids.length} entreprise${ids.length > 1 ? 's' : ''} supprimée${ids.length > 1 ? 's' : ''}`,
              onChange: load,
            })
          }}
          emptyState={{ icon: Building2, title: 'Aucune entreprise', description: "Aucune entreprise n'est encore enregistrée. Ajoute une entreprise pour gérer ses contacts, commandes et factures.", cta: { label: 'Nouvelle entreprise', icon: Plus, onClick: openCreate } }}
        />
      )}
    </ListPage>
  )
}
