import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, X, Database, Pencil } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { fmtDate } from '../lib/formatDate.js'
import { useDisabledColumns } from '../lib/useDisabledColumns.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import CustomFieldModal from '../components/CustomFieldModal.jsx'
import { customFieldToColumn } from '../lib/customFieldDisplay.jsx'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

const PROJECT_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']

// Indicateur d'autosave discret (mode édition uniquement).
function AutosaveStatus({ state }) {
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-400">
        <span className="inline-block w-3 h-3 border border-slate-300 border-t-transparent rounded-full animate-spin" />
        Enregistrement…
      </span>
    )
  }
  if (state === 'saved') return <span className="text-xs text-green-600">Enregistré</span>
  if (state === 'error') return <span className="text-xs text-red-600">Échec de la sauvegarde</span>
  return null
}

function ProjectForm({ initial = {}, companies = [], onSave, onClose }) {
  // Mode édition d'un record existant → autosave on-change debounced, pas de
  // bouton « Enregistrer » (règle de design CLAUDE.md). Mode création → submit
  // classique (exception autosave : pas encore d'id).
  const editing = !!initial?.id
  const { addToast } = useToast()
  const [form, setForm] = useState({
    name: '', company_id: '', contact_id: '',
    type: '', status: 'Ouvert', probability: 50, value_cad: '',
    monthly_cad: '', nb_greenhouses: 0, close_date: '', notes: '',
    refusal_reason: '', ...initial
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error

  // File d'attente de patch fusionnés + timer de debounce pour l'autosave.
  const persistTimer = useRef(null)
  const persistQueue = useRef({})

  const doPersist = useCallback(async () => {
    const patch = persistQueue.current
    persistQueue.current = {}
    // Le nom est non-nullable côté serveur : ne jamais persister un nom vide.
    if ('name' in patch && !String(patch.name).trim()) delete patch.name
    if (Object.keys(patch).length === 0) { setSaveState('idle'); return }
    setSaveState('saving')
    try {
      await api.projects.update(initial.id, patch)
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      addToast({ message: e.message, type: 'error' })
    }
  }, [initial.id, addToast])

  const schedulePersist = useCallback((patch) => {
    Object.assign(persistQueue.current, patch)
    setSaveState('saving')
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(doPersist, 500)
  }, [doPersist])

  // Flush des patchs en attente si la modale se ferme avant le debounce.
  useEffect(() => {
    if (!editing) return
    return () => {
      clearTimeout(persistTimer.current)
      const patch = persistQueue.current
      persistQueue.current = {}
      if ('name' in patch && !String(patch.name).trim()) delete patch.name
      if (Object.keys(patch).length) api.projects.update(initial.id, patch).catch(() => {})
    }
  }, [editing, initial.id])

  // Setter unifié : met à jour l'état local et, en édition, programme l'autosave.
  const setField = useCallback((patch) => {
    setForm(f => ({ ...f, ...patch }))
    if (editing) schedulePersist(patch)
  }, [editing, schedulePersist])

  async function handleSubmit(e) {
    e.preventDefault()
    if (editing) return // autosave : pas de submit en édition
    setError('')
    setSaving(true)
    try { await onSave(form); onClose() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="label">Nom du projet *</label>
          <input value={form.name} onChange={e => setField({ name: e.target.value })} className="input" required />
        </div>
        <div>
          <label className="label">Entreprise</label>
          <LinkedRecordField
            name="pipeline_company_id"
            value={form.company_id}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={v => setField({ company_id: v })}
          />
        </div>
        <div>
          <label className="label">Type</label>
          <select value={form.type} onChange={e => setField({ type: e.target.value })} className="select">
            <option value="">—</option>
            {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={e => setField({ status: e.target.value })} className="select">
            <option value="Ouvert">Ouvert</option>
            <option value="Gagné">Gagné</option>
            <option value="Perdu">Perdu</option>
          </select>
        </div>
        <div>
          <label className="label">Probabilité (%)</label>
          <input type="range" min="0" max="100" step="5" value={form.probability}
            onChange={e => setField({ probability: parseInt(e.target.value) })}
            className="w-full mt-1"
          />
          <div className="text-center text-sm font-medium text-brand-600">{form.probability}%</div>
        </div>
        <div>
          <label className="label">Date de clôture prévue</label>
          <input type="date" value={form.close_date} onChange={e => setField({ close_date: e.target.value })} className="input" />
        </div>
        {form.status === 'Perdu' && (
          <div className="col-span-2">
            <label className="label">Raison du refus</label>
            <input value={form.refusal_reason} onChange={e => setField({ refusal_reason: e.target.value })} className="input" />
          </div>
        )}
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea value={form.notes} onChange={e => setField({ notes: e.target.value })} className="input" rows={3} />
        </div>
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {editing ? (
        // Autosave : pas de bouton « Enregistrer », juste un statut + fermeture.
        <div className="flex justify-end items-center gap-3 pt-2">
          <AutosaveStatus state={saveState} />
          <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
        </div>
      ) : (
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
        </div>
      )}
    </form>
  )
}


export default function Pipeline() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const monthFilter = searchParams.get('month') // e.g. "2026-03" — filters by close_date/updated_at
  const createdMonthFilter = searchParams.get('createdMonth') // e.g. "2026-03" — filters by created_at
  const [projects, setProjects] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editProject, setEditProject] = useState(null)
  const disabledCols = useDisabledColumns('projects') // Map<column_name, { airtable_field_name }>
  const { fields: customFields, loaded: customFieldsLoaded, reload: reloadCustomFields } = useCustomFields('projects')
  const [customFieldModal, setCustomFieldModal] = useState(null) // { editing: field|null }
  const confirm = useConfirm()
  const { addToast } = useToast()

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
      const d = p.close_date || p.updated_at || ''
      return d.startsWith(monthFilter)
    })
  }, [projects, monthFilter, createdMonthFilter])

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.projects.map(meta => ({
    ...meta,
    render:
      meta.id === 'name' ? row => (
        <div className="group flex items-start justify-between gap-2">
          <div>
            <div className="font-medium text-slate-900">{row.name}</div>
            {row.type && <div className="text-xs text-slate-400">{row.type}</div>}
          </div>
          <button
            type="button"
            title="Modifier le projet"
            data-testid={`edit-project-${row.id}`}
            onClick={e => { e.stopPropagation(); setEditProject(row) }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 -m-1 text-slate-400 hover:text-brand-600 flex-shrink-0"
          >
            <Pencil size={14} />
          </button>
        </div>
      ) :
      meta.id === 'company_name' ? row => row.company_id
        ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
        : <span className="text-slate-400">—</span> :
      meta.id === 'status' ? row => (
        <Badge color={projectStatusColor(row.status)}>{row.status}</Badge>
      ) :
      meta.id === 'probability' ? row => {
        if (row.probability == null) return <span className="text-slate-400">—</span>
        const color = row.probability >= 75 ? 'text-green-600' : row.probability >= 40 ? 'text-amber-500' : 'text-red-500'
        return <span className={`font-semibold ${color}`}>{row.probability}%</span>
      } :
      meta.id === 'value_cad' ? row => (
        <span className="font-medium text-slate-700">{fmtCad(row.value_cad)}</span>
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
            <h1 className="text-2xl font-bold text-slate-900">Projets</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/projects/fields" className="btn-secondary flex items-center gap-2" title="Gérer les champs (renommer, type, mapping Airtable)">
              <Database size={15} className="text-brand-500" />
              <span>Champs</span>
            </Link>
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau projet
            </button>
          </div>
        </div>

        {monthFilter && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700">
            <span>Filtre : {new Date(monthFilter + '-15').toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })} · groupés par statut</span>
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
          onRowClick={row => navigate(`/projects/${row.id}`)}
          onCellEdit={(row, col, value) => updateProjectField(row.id, col.field, value)}
          searchFields={['name', 'company_name', 'type', 'vendeur_label', 'nom_du_vendeur', 'value_cad', 'monthly_cad']}
          initialGroupBy={monthFilter ? 'status' : null}
          forceAllView={!!monthFilter || !!createdMonthFilter}
          disabledColumns={disabledCols}
          onAddCustomField={() => setCustomFieldModal({ editing: null })}
          customFieldsByColumn={customFieldsByColumn}
          customFieldsLoaded={customFieldsLoaded}
          onEditCustomField={(field) => setCustomFieldModal({ editing: field })}
          onDeleteCustomField={handleDeleteCustomField}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau projet" size="lg">
        <ProjectForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <Modal isOpen={!!editProject} onClose={() => setEditProject(null)} title="Modifier le projet" size="lg">
        {editProject && (
          <ProjectForm initial={editProject} companies={companies} onClose={() => setEditProject(null)} />
        )}
      </Modal>

      <CustomFieldModal
        isOpen={!!customFieldModal}
        onClose={() => setCustomFieldModal(null)}
        erpTable="projects"
        editing={customFieldModal?.editing || null}
        onSaved={() => { reloadCustomFields(); load() }}
        onDeleted={() => { reloadCustomFields(); load() }}
      />
    </Layout>
  )
}
