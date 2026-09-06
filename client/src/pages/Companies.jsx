import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { Plus, X, Building2 } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge, phaseBadgeColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
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
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const undoableDelete = useUndoableDelete()

  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const load = useCallback(async () => {
    const extraParams = {}
    if (farmProvince) extraParams.farm_province = farmProvince
    if (shippingProvince) extraParams.shipping_province = shippingProvince
    await loadProgressive(
      (page, limit) => api.companies.list({ limit, page, ...extraParams }),
      setCompanies, setLoading
    )
  }, [farmProvince, shippingProvince])

  useEffect(() => { load() }, [load])

  useRealtimeChannel('companies:list', (msg) => {
    if (msg.type === 'company:created') {
      if (farmProvince || shippingProvince) return // province-filtered view: defer
      setCompanies(prev => prev.some(c => c.id === msg.payload.id) ? prev : [msg.payload, ...prev])
    } else if (msg.type === 'company:updated') {
      setCompanies(prev => prev.map(c => c.id === msg.payload.id ? { ...c, ...msg.payload } : c))
    } else if (msg.type === 'company:deleted') {
      setCompanies(prev => prev.filter(c => c.id !== msg.payload.id))
    }
  })

  async function handleCreate(form) {
    await api.companies.create(form)
    load()
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <PageTitle>Entreprises</PageTitle>
            {farmProvince && (
              <div className="flex items-center gap-2 mt-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1">
                  Ferme en {farmProvince}
                  <button onClick={() => setSearchParams({})} className="hover:text-blue-900">
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}
            {shippingProvince && (
              <div className="flex items-center gap-2 mt-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1">
                  Client — livraison en {shippingProvince}
                  <button onClick={() => setSearchParams({})} className="hover:text-blue-900">
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvelle entreprise
            </button>
          </div>
        </div>

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
          emptyState={{ icon: Building2, title: 'Aucune entreprise', description: "Aucune entreprise n'est encore enregistrée. Ajoute une entreprise pour gérer ses contacts, commandes et factures.", cta: { label: 'Nouvelle entreprise', icon: Plus, onClick: () => setShowModal(true) } }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvelle entreprise" size="lg">
        <RecordForm
          table="companies"
          fields={COMPANY_FORM_FIELDS}
          columns={2}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
          extra={values => <DuplicateWarning kind="company" values={values} />}
        />
      </Modal>
    </Layout>
  )
}
