import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, X } from 'lucide-react'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, phaseBadgeColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

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
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
            <option value="">— Sélectionner —</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Phase</label>
          <select value={form.lifecycle_phase} onChange={e => setForm(f => ({ ...f, lifecycle_phase: e.target.value }))} className="select">
            <option value="">— Sélectionner —</option>
            {PHASES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
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

  async function handleCreate(form) {
    await api.companies.create(form)
    load()
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
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
            <TableConfigModal table="companies" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouvelle entreprise
            </button>
          </div>
        </div>

        <DataTable
          table="companies"
          columns={COLUMNS}
          data={companies}
          loading={loading}
          onRowClick={row => navigate(`/companies/${row.id}`)}
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
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvelle entreprise" size="lg">
        <CompanyForm onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
    </Layout>
  )
}
