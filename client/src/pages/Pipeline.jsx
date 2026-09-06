import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { usePeekOpenId } from '../lib/usePeekOpenId.js'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { RecordForm } from '../components/RecordForm.jsx'
import ProjectDetail from './ProjectDetail.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'
import { useDisabledColumns } from '../lib/useDisabledColumns.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import CustomFieldModal from '../components/CustomFieldModal.jsx'
import { FieldAirtableMapping } from '../components/FieldAirtableMapping.jsx'
import { customFieldToColumn } from '../lib/customFieldDisplay.jsx'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

import { fmtMoney } from '../utils/formatters.js'

const PROJECT_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']

// Champs proposés par le formulaire « Nouveau projet » — liste calquée sur ce
// que POST /api/projects persiste (voir RecordForm.jsx pour la configuration).
// « Raison du refus » n'y figure pas : la route de création ne l'accepte pas, un
// champ qui ne sauvegarde pas n'a rien à faire dans un formulaire d'ajout.
function projectFormFields(companies) {
  return [
    { field: 'name', label: 'Nom du projet', span: 2, locked: true, required: true },
    {
      field: 'company_id', label: 'Entreprise',
      input: ({ value, onChange }) => (
        <LinkedRecordField
          name="pipeline_company_id"
          value={value}
          options={companies}
          labelFn={c => c.name}
          getHref={c => `/companies/${c.id}`}
          onChange={onChange}
        />
      ),
    },
    { field: 'type', label: 'Type', type: 'select', options: PROJECT_TYPES },
    {
      field: 'probability', label: 'Probabilité (%)', defaultValue: 50,
      input: ({ value, onChange, id }) => (
        <>
          <input
            id={id}
            type="range" min="0" max="100" step="5" value={value}
            onChange={e => onChange(parseInt(e.target.value))}
            className="w-full mt-1"
          />
          <div className="text-center text-sm font-medium text-brand-600">{value}%</div>
        </>
      ),
    },
    { field: 'close_date', label: 'Date de clôture prévue', type: 'date' },
    { field: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    // Masqués par défaut — disponibles via « Modifier le formulaire ».
    { field: 'value_cad', label: 'Valeur (CAD)', type: 'currency', min: '0', visible: false },
    { field: 'monthly_cad', label: 'Récurrent mensuel (CAD)', type: 'currency', min: '0', visible: false },
    { field: 'nb_greenhouses', label: 'Nombre de serres', type: 'number', min: '0', visible: false },
    // Pas de champ « Statut » : il a été retiré des projets (voir /champs/projects
    // et e2e/tests/projects-no-status-field.test.js) — l'offrir ici le ferait
    // revenir par la porte de derrière.
  ]
}

export default function Pipeline() {
  const [searchParams, setSearchParams] = useSearchParams()
  const monthFilter = searchParams.get('month') // e.g. "2026-03" — filters by close_date/creation
  const createdMonthFilter = searchParams.get('createdMonth') // e.g. "2026-03" — filters by created_at
  const [projects, setProjects] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const disabledCols = useDisabledColumns('projects') // Map<column_name, { airtable_field_name }>
  const { fields: customFields, loaded: customFieldsLoaded, reload: reloadCustomFields } = useCustomFields('projects')
  const [customFieldModal, setCustomFieldModal] = useState(null) // { editing: field|null }
  const confirm = useConfirm()
  const { addToast } = useToast()

  const { peekOpenId, consumePeekOpen } = usePeekOpenId()

  const customFieldsByColumn = useMemo(() => {
    const m = new Map()
    for (const f of customFields) m.set(f.column_name, f)
    return m
  }, [customFields])

  async function handleDeleteCustomField(field) {
    // Rapport d'usage : liste les dépendances (champs calculés, automations,
    // vues, règles de visibilité) que la suppression va affecter, avant de les
    // casser en silence (#ERROR).
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch {}
    const depMsg = summarizeDependents(dependents)
    if (!(await confirm({
      title: 'Supprimer le champ',
      message: `Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.${depMsg}`,
      confirmLabel: dependents.length ? 'Supprimer quand même' : 'Supprimer',
    }))) return
    try {
      await api.customFields.delete(field.id)
      addToast({ message: 'Champ supprimé', type: 'success' })
      await reloadCustomFields()
      load() // recharge les projets pour refléter la perte de la colonne
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  // Chargement en deux temps : (1) lite=1 → peinture rapide avec les colonnes
  // visibles par défaut, sans sous-requêtes orders/vendeur_label ; (2) refetch
  // silencieux de la version complète pour remplir orders, vendeur_label, notes
  // et autres colonnes masquées. Le second appel ne bascule pas `loading` à true
  // pour éviter un flash.
  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.projects.list({ limit, page, lite: 1 }),
      setProjects, setLoading
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    load().then(() => {
      if (cancelled) return
      api.projects.list({ limit: 'all', page: 1 })
        .then(res => { if (!cancelled) setProjects(res?.data || []) })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [load])
  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

  useEntityListRealtime('project', setProjects)

  // Filtre par mois si présent dans l'URL
  const displayedProjects = useMemo(() => {
    if (createdMonthFilter) {
      // Filtre sur `creation` en UTC — cohérent avec le bucketing du dashboard
      // (strftime UTC) et avec l'affichage `fmtDate` qui détecte le pattern
      // Airtable midnight-UTC.
      return projects.filter(p => (p.creation || '').slice(0, 7) === createdMonthFilter)
    }
    if (!monthFilter) return projects
    return projects.filter(p => {
      // Même bucketing que le graphique « Taux de closing » du dashboard :
      // close_date si renseignée, sinon `creation` (jamais `updated_at`, qui
      // reflète la dernière synchro et non la vie du projet).
      const d = p.close_date || p.creation || ''
      return d.startsWith(monthFilter)
    })
  }, [projects, monthFilter, createdMonthFilter])

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.projects.map(meta => ({
    ...meta,
    render:
      // Pas de crayon d'édition sur la ligne : la fiche s'ouvre en side-peek
      // (autosave) au clic sur la ligne, c'est là qu'on modifie un projet.
      meta.id === 'name' ? row => (
        <div className="font-medium text-slate-900">{row.name}</div>
      ) :
      meta.id === 'company_name' ? row => row.company_id
        ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
        : <span className="text-slate-400">—</span> :
      meta.id === 'probability' ? row => {
        if (row.probability == null) return <span className="text-slate-400">—</span>
        const color = row.probability >= 75 ? 'text-green-600' : row.probability >= 40 ? 'text-amber-500' : 'text-red-500'
        return <span className={`font-semibold ${color}`}>{row.probability}%</span>
      } :
      meta.id === 'value_cad' ? row => (
        <span className="font-medium text-slate-700">{fmtMoney(row.value_cad, 'CAD', { maximumFractionDigits: 0 })}</span>
      ) :
      meta.id === 'close_date' ? row => (
        <span className="text-slate-500">{fmtDate(row.close_date)}</span>
      ) :
      meta.id === 'orders' ? row => {
        if (!row.orders?.length) return <span className="text-slate-400">—</span>
        return (
          <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
            {row.orders.map(o => (
              <Link key={o.id} to={`/orders/${o.id}`}
                className="font-mono text-xs text-brand-600 hover:underline bg-brand-50 px-1.5 py-0.5 rounded">
                #{o.order_number}
              </Link>
            ))}
          </div>
        )
      } :
      undefined
  })), []) // setEditProject est stable (setState)

  // Sauvegarde d'une valeur de champ (édition tableur de DataTable → onCellEdit).
  const updateProjectField = useCallback(async (projectId, columnName, value) => {
    try {
      await api.projects.update(projectId, { [columnName]: value })
      // Patch optimiste — évite un reload complet à chaque blur.
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, [columnName]: value } : p))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast])

  // Colonnes finales = colonnes hardcodées + champs custom (mapping partagé,
  // voir customFieldToColumn — éditable pour kind='data' via le mode tableur).
  const COLUMNS_WITH_CUSTOM = useMemo(
    () => [...COLUMNS, ...customFields.map(customFieldToColumn)],
    [COLUMNS, customFields]
  )

  async function handleCreate(form) { await api.projects.create(form); load() }

  return (
    <Layout>
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <PageTitle>Projets</PageTitle>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau projet
            </button>
          </div>
        </div>

        {monthFilter && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700">
            <span>Filtre : {new Date(monthFilter + '-15').toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}</span>
            <button onClick={() => setSearchParams({})} className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700">
              <X size={13} /> Effacer
            </button>
          </div>
        )}
        {createdMonthFilter && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700">
            <span>Projets créés en {new Date(createdMonthFilter + '-15').toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}</span>
            <button onClick={() => setSearchParams({})} className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:text-brand-700">
              <X size={13} /> Effacer
            </button>
          </div>
        )}
        <DataTable
          table="projects"
          manageViews
          columns={COLUMNS_WITH_CUSTOM}
          data={displayedProjects}
          loading={loading}
          peek={{
            title: row => row.name || 'Projet',
            subtitle: row => [row.company_name, row.type].filter(Boolean).join(' · '),
            to: row => `/projects/${row.id}`,
            width: 720,
            openId: peekOpenId,
            onOpenConsumed: consumePeekOpen,
            render: (row, { close }) => <ProjectDetail recordId={row.id} embedded onClose={close} />,
          }}
          onCellEdit={(row, col, value) => updateProjectField(row.id, col.field, value)}
          searchFields={['name', 'company_name', 'type', 'vendeur_label', 'nom_du_vendeur', 'value_cad', 'monthly_cad']}
          forceAllView={!!monthFilter || !!createdMonthFilter}
          disabledColumns={disabledCols}
          onAddCustomField={() => setCustomFieldModal({ editing: null })}
          customFieldsByColumn={customFieldsByColumn}
          customFieldsLoaded={customFieldsLoaded}
          // Le menu d'en-tête (duplication, masquage global) crée ou masque des
          // champs sans passer par les gestionnaires de cette page : sans ce
          // rappel, sa liste de champs resterait périmée jusqu'au rechargement.
          onFieldsChanged={async () => { await reloadCustomFields(); load() }}
          onEditCustomField={(field) => setCustomFieldModal({ editing: field })}
          onDeleteCustomField={handleDeleteCustomField}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau projet" size="lg">
        <RecordForm
          table="projects"
          fields={projectFormFields(companies)}
          columns={2}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
        />
      </Modal>

      <CustomFieldModal
        isOpen={!!customFieldModal}
        onClose={() => setCustomFieldModal(null)}
        erpTable="projects"
        editing={customFieldModal?.editing || null}
        mappingSlot={customFieldModal?.editing ? (
          <FieldAirtableMapping
            table="projects"
            column={customFieldModal.editing.column_name}
            cfKind={customFieldModal.editing.kind}
          />
        ) : null}
        onSaved={() => { reloadCustomFields(); load() }}
        onDeleted={() => { reloadCustomFields(); load() }}
      />
    </Layout>
  )
}
