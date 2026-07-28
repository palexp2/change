import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { Plus, X, Building2 } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, phaseBadgeColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import CompanyDetail from './CompanyDetail.jsx'

const TYPES = ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin',
  'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire',
  'Compétiteur', 'Consultant', 'Autre']

const PHASES = ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore']

const RENDERS = {
  name: row => (
    <div>
      <div className="font-medium text-slate-900">{row.name}</div>
      {row.city && <div className="text-xs text-slate-400">{row.city}{row.province ? `, ${row.province}` : ''}</div>}
    </div>
  ),
  lifecycle_phase: row => row.lifecycle_phase
    ? <Badge color={phaseBadgeColor(row.lifecycle_phase)}>{row.lifecycle_phase}</Badge>
    : <span className="text-slate-400">—</span>,
}

const COLUMNS = TABLE_COLUMN_META.companies.map(meta => ({
  ...meta,
  render: RENDERS[meta.id],
}))

function CompanyForm({ initial = {}, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '', type: '', lifecycle_phase: '', phone: '', email: '',
    website: '', address: '', city: '', province: '', country: 'Canada', notes: '',
    ...initial,
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
        <div className="col-span-2">
          <label className="label">Nom *</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Type</label>
          {/* Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche. */}
          <SearchableSelect
            value={form.type}
            options={TYPES.map(t => ({ value: t, label: t }))}
            onChange={v => setForm(f => ({ ...f, type: v }))}
            emptyOption="— Sélectionner —"
            placeholder="— Sélectionner —"
            className="input w-full"
            size="sm"
            testId="company-form-type"
          />
        </div>
        <div>
          <label className="label">Phase</label>
          {/* Cohérence : même composant searchable que « Type » ci-dessus et que CompanyDetail. */}
          <SearchableSelect
            value={form.lifecycle_phase}
            options={PHASES.map(p => ({ value: p, label: p }))}
            onChange={v => setForm(f => ({ ...f, lifecycle_phase: v }))}
            emptyOption="— Sélectionner —"
            placeholder="— Sélectionner —"
            className="input w-full"
            size="sm"
            testId="company-form-phase"
          />
        </div>
        <div>
          <label className="label">Téléphone</label>
          <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Courriel</label>
          <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" />
        </div>
        <div className="col-span-2">
          <label className="label">Site web</label>
          <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} className="input" placeholder="https://" />
        </div>
        <div className="col-span-2">
          <label className="label">Adresse</label>
          <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Ville</label>
          <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Province</label>
          <input value={form.province} onChange={e => setForm(f => ({ ...f, province: e.target.value }))} className="input" />
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={3} />
        </div>
      </div>
      {/* Création seulement : on n'avertit pas en édition (pas de doublon avec soi-même). */}
      {!initial.id && <DuplicateWarning kind="company" values={form} />}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? 'Enregistrement...' : 'Enregistrer'}
        </button>
      </div>
    </form>
  )
}

export default function Companies() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const farmProvince = searchParams.get('farm_province') || ''
  const shippingProvince = searchParams.get('shipping_province') || ''
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const undoableDelete = useUndoableDelete()

  // Ouverture du side-peek demandée par la fiche plein écran (« revenir au
  // panneau latéral ») — l'id voyage via location.state.peekId. Consommée une
  // fois le drawer ouvert, et le state d'historique est nettoyé pour qu'un
  // refresh ne rouvre pas le drawer. Même pattern que Factures.jsx.
  const location = useLocation()
  const [peekOpenId, setPeekOpenId] = useState(() => location.state?.peekId ?? null)
  const consumePeekOpen = useCallback(() => {
    setPeekOpenId(null)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [navigate, location.pathname, location.search])

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
            <h1 className="text-2xl font-bold text-slate-900">Entreprises</h1>
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
            render: (row, { close }) => <CompanyDetail recordId={row.id} embedded onClose={close} />,
          }}
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
        <CompanyForm onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
