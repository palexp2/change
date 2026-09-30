import { hasRole } from '../../../shared/roles.mjs'
import { useAuth } from '../lib/auth.jsx'
import { useNavigate } from 'react-router-dom'
import { Users, Plus } from 'lucide-react'
import api from '../lib/api.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import EmployeeDetail from './EmployeeDetail.jsx'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

// Tous les champs de la table sont des champs personnalisés : leur rendu vient
// du renderer commun (renderCustomFieldValue). Seule la colonne « Nom » garde un
// rendu maison — pastille d'initiales + prénom et nom, que ni un champ texte ni
// une formule ne sait produire.
const RENDERS = {
  last_name: row => (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-semibold text-xs flex-shrink-0">
        {(row.first_name?.[0] || '') + (row.last_name?.[0] || '')}
      </div>
      <span className="font-medium text-slate-900">{row.first_name} {row.last_name}</span>
    </div>
  ),
}

const COLUMNS = TABLE_COLUMN_META.employees.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// Champs proposés par le formulaire « Nouvel employé ». POST /api/employees
// accepte toute colonne de sa liste blanche : les champs masqués par défaut sont
// donc réellement persistés si l'utilisateur les ajoute au formulaire (voir
// RecordForm.jsx).
const EMPLOYEE_FORM_FIELDS = [
  { field: 'first_name', label: 'Prénom', locked: true, required: true },
  { field: 'last_name', label: 'Nom', locked: true, required: true },
  // Masqués par défaut — disponibles via « Modifier le formulaire ».
  { field: 'matricule', label: 'Matricule', visible: false },
  { field: 'email_work', label: 'Courriel (travail)', type: 'email', visible: false },
  { field: 'email_personal', label: 'Courriel (personnel)', type: 'email', visible: false },
  { field: 'phone_work', label: 'Téléphone (travail)', visible: false },
  { field: 'phone_personal', label: 'Téléphone (personnel)', visible: false },
  { field: 'hire_date', label: "Date d'embauche", type: 'date', visible: false },
  { field: 'birth_date', label: 'Date de naissance', type: 'date', visible: false },
  { field: 'hours_per_week', label: 'Heures par semaine', type: 'number', min: '0', visible: false },
  { field: 'address', label: 'Adresse', visible: false },
  { field: 'active', label: 'Actif', visible: false, defaultValue: 1 },
]

export default function Employees() {
  const { user } = useAuth()
  const isHR = hasRole(user, 'rh')
  const navigate = useNavigate()
  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const { rows: employees, loading } = useListData({
    fetch: (page, limit) => api.employees.list({ limit, page }),
    realtime: 'employee',
  })

  return (
    <ListPage
      title={isHR ? "Employés" : "Ma fiche personnelle"}
      create={isHR ? {
        label: 'Nouvel employé', table: 'employees', fields: EMPLOYEE_FORM_FIELDS, columns: 2,
        onSubmit: async form => { const emp = await api.employees.create(form); navigate(`/employees/${emp.id}`) },
        submitLabel: 'Créer et ouvrir',
        savingLabel: 'Création…',
        extra: (
          <p className="text-xs text-slate-500">
            Les autres informations s'éditent directement sur la fiche de l'employé (autosave).
          </p>
        ),
      } : undefined}
    >
      {({ openCreate }) => (
        <>
          <DataTable
            table="employees"
            manageViews
            columns={COLUMNS}
            data={employees}
            loading={loading}
            peek={{
              title: row => `${row.first_name || ''} ${row.last_name || ''}`.trim() || `Employé #${row.id}`,
              subtitle: row => row.job_title || row.email_work || '',
              to: row => `/employees/${row.id}`,
              width: 760,
              openId: peekOpenId,
              onOpenConsumed: consumePeekOpen,
              render: (row, { close }) => <EmployeeDetail recordId={row.id} embedded onClose={close} />,
            }}
            searchFields={['first_name', 'last_name', 'matricule', 'email_work', 'email_personal']}
            emptyState={!isHR ? { icon: Users, title: "Aucune fiche liée", description: "Demandez à un administrateur de relier votre compte à votre fiche employé." } : { icon: Users, title: 'Aucun employé', description: "Aucun employé n'est encore enregistré. Ajoute un employé pour gérer la paie et les feuilles de temps.", cta: { label: 'Nouvel employé', icon: Plus, onClick: openCreate } }}
          />
        </>
      )}
    </ListPage>
  )
}
