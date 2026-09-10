import { useState, useEffect, useMemo } from 'react'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { Link, useNavigate } from 'react-router-dom'
import { Send } from 'lucide-react'
import api from '../lib/api.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { ListPage } from '../components/ListPage.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { HubSpotExportModal } from '../components/HubSpotExportModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

const RENDERS = {
  // Les lignes de cette liste portent le nom complet sous `last_name`,
  // pour que le rendu et les tris enregistrés utilisent la même valeur.
  last_name: row => {
    const name = row.last_name
    return name
      ? <div className="font-medium text-slate-900">{name}</div>
      : <span className="text-slate-400">—</span>
  },
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.company_name}</Link>
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
  const navigate = useNavigate()
  const [companies, setCompanies] = useState([])
  const [showHubspotExport, setShowHubspotExport] = useState(false)
  const [filteredContacts, setFilteredContacts] = useState([])
  const undoableDelete = useUndoableDelete()

  // Cache global : hydraté au login par /api/bootstrap, rafraîchi par delta
  // polling toutes les 10s + sync() manuel après une mutation locale.
  const { rows: contactsRaw, loading, reload } = useListData({ table: 'contacts' })
  const companiesRaw = useTable('companies')

  // Le bootstrap envoie les colonnes brutes — on joint company_name côté client
  // depuis le cache companies pour que la colonne "Entreprise" s'affiche.
  const contacts = useMemo(() => {
    const cById = new Map(companiesRaw.map(c => [c.id, c.name]))
    return contactsRaw.map(r => {
      const name = `${r.first_name || ''} ${r.last_name || ''}`.trim()
      const fullName = name === 'Inconnu' ? '' : name
      // Projection locale à la liste : le cache conserve le nom de famille.
      // `full_name` reste disponible pour les tris des anciennes vues.
      return {
        ...r,
        last_name: fullName,
        full_name: fullName,
        company_name: cById.get(r.company_id) || r.company_name,
      }
    })
  }, [contactsRaw, companiesRaw])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

  async function handleCreate(form) {
    await api.contacts.create(form)
    await reload()
  }

  return (
    <ListPage
      title="Contacts"
      actions={
        <button
          onClick={() => setShowHubspotExport(true)}
          className="btn-secondary"
          title="Créer une liste statique HubSpot avec la vue filtrée"
        >
          <Send size={16} /> Exporter vers HubSpot
        </button>
      }
      create={{
        label: 'Nouveau contact', table: 'contacts', fields: contactFormFields(companies), columns: 2,
        onSubmit: handleCreate,
        extra: values => <DuplicateWarning kind="contact" values={values} />,
      }}
    >
      <DataTable
        table="contacts"
        manageViews
        sortIndicator
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
            onChange: reload,
          })
        }}
      />

      <HubSpotExportModal
        isOpen={showHubspotExport}
        onClose={() => setShowHubspotExport(false)}
        filteredContacts={filteredContacts}
      />
    </ListPage>
  )
}
