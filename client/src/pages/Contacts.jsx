import { useState, useEffect, useMemo } from 'react'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Send } from 'lucide-react'
import api from '../lib/api.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { HubSpotExportModal } from '../components/HubSpotExportModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const RENDERS = {
  full_name: row => (
    <div className="font-medium text-slate-900">{row.first_name} {row.last_name}</div>
  ),
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  language: row => row.language
    ? <Badge color={row.language === 'French' ? 'blue' : 'green'}>{row.language === 'French' ? 'FR' : 'EN'}</Badge>
    : null,
}

const COLUMNS = TABLE_COLUMN_META.contacts.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function ContactForm({ initial = {}, companies = [], onSave, onClose }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '', mobile: '',
    company_id: '', language: '',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Prénom *</label>
          <input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Nom *</label>
          <input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Courriel</label>
          <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Téléphone</label>
          <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Mobile</label>
          <input value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} className="input" />
        </div>
        <div>
          <label className="label">Langue</label>
          <select value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))} className="select">
            <option value="">—</option>
            <option value="French">Français</option>
            <option value="English">Anglais</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Entreprise</label>
          <LinkedRecordField
            name="contact_company_id"
            value={form.company_id}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={v => setForm(f => ({ ...f, company_id: v }))}
          />
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

export default function Contacts() {
  const navigate = useNavigate()
  const [companies, setCompanies] = useState([])
  const [showModal, setShowModal] = useState(false)
  const [showHubspotExport, setShowHubspotExport] = useState(false)
  const [filteredContacts, setFilteredContacts] = useState([])
  const undoableDelete = useUndoableDelete()

  // Cache global : hydraté au login par /api/bootstrap, rafraîchi par delta
  // polling toutes les 10s + sync() manuel après une mutation locale.
  const contactsRaw = useTable('contacts')
  const companiesRaw = useTable('companies')
  const loading = !isTableHydrated('contacts')

  // Le bootstrap envoie les colonnes brutes — on joint company_name côté client
  // depuis le cache companies pour que la colonne "Entreprise" s'affiche.
  const contacts = useMemo(() => {
    if (!companiesRaw.length) return contactsRaw
    const cById = new Map(companiesRaw.map(c => [c.id, c.name]))
    return contactsRaw.map(r => r.company_id
      ? { ...r, company_name: cById.get(r.company_id) || r.company_name }
      : r)
  }, [contactsRaw, companiesRaw])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

  async function handleCreate(form) {
    await api.contacts.create(form)
    await syncStore()
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Contacts</h1>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="contacts" bulkDelete />
            <button
              onClick={() => setShowHubspotExport(true)}
              className="btn-secondary"
              title="Créer une liste statique HubSpot avec la vue filtrée"
            >
              <Send size={16} /> Exporter vers HubSpot
            </button>
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau contact
            </button>
          </div>
        </div>

        <DataTable
          table="contacts"
          columns={COLUMNS}
          data={contacts}
          loading={loading}
          onRowClick={row => navigate(`/contacts/${row.id}`)}
          searchFields={['first_name', 'last_name', 'email', 'phone', 'mobile', 'company_name']}
          onFilteredDataChange={setFilteredContacts}
          onBulkDelete={async (ids) => {
            await undoableDelete({
              table: 'contacts',
              ids,
              deleteFn: () => Promise.all(ids.map(id => api.contacts.delete(id))),
              label: `${ids.length} contact${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`,
              onChange: syncStore,
            })
          }}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau contact">
        <ContactForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <HubSpotExportModal
        isOpen={showHubspotExport}
        onClose={() => setShowHubspotExport(false)}
        filteredContacts={filteredContacts}
      />
    </Layout>
  )
}
