import { useState, useEffect, useMemo } from 'react'
import { useTable, isTableHydrated } from '../lib/dataStore.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { Link } from 'react-router-dom'
import { Plus, Send } from 'lucide-react'
import api from '../lib/api.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import ContactDetail from './ContactDetail.jsx'
import { HubSpotExportModal } from '../components/HubSpotExportModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
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

// Champs proposés par le formulaire « Nouveau contact » — liste calquée sur ce
// que POST /api/contacts persiste (voir RecordForm.jsx pour la configuration).
function contactFormFields(companies) {
  return [
    { field: 'first_name', label: 'Prénom', locked: true, required: true },
    { field: 'last_name', label: 'Nom', locked: true, required: true },
    { field: 'email', label: 'Courriel', type: 'email' },
    { field: 'phone', label: 'Téléphone' },
    { field: 'mobile', label: 'Mobile' },
    { field: 'language', label: 'Langue', type: 'select', options: [{ value: 'French', label: 'Français' }, { value: 'English', label: 'Anglais' }] },
    {
      field: 'company_id', label: 'Entreprise', span: 2,
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="contact_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          onChange={onChange}
        />
      ),
    },
    // Masqué par défaut — disponible via « Modifier le formulaire ».
    { field: 'notes', label: 'Notes', type: 'textarea', span: 2, visible: false },
  ]
}

export default function Contacts() {
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
            <PageTitle>Contacts</PageTitle>
          </div>
          <div className="flex items-center gap-2">
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
          manageViews
          columns={COLUMNS}
          data={contacts}
          loading={loading}
          peek={{
            title: row => `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Contact',
            subtitle: row => row.company_name || row.email || '',
            to: row => `/contacts/${row.id}`,
            render: (row, { close }) => <ContactDetail recordId={row.id} embedded onClose={close} />,
          }}
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
        <RecordForm
          table="contacts"
          fields={contactFormFields(companies)}
          columns={2}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
          extra={values => <DuplicateWarning kind="contact" values={values} />}
        />
      </Modal>

      <HubSpotExportModal
        isOpen={showHubspotExport}
        onClose={() => setShowHubspotExport(false)}
        filteredContacts={filteredContacts}
      />
    </Layout>
  )
}
