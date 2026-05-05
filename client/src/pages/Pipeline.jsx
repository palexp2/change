import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, X, Database } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useDisabledColumns } from '../lib/useDisabledColumns.js'
import { useCustomFields } from '../lib/useCustomFields.js'
import CustomFieldModal from '../components/CustomFieldModal.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

// Cellule éditable inline pour un champ custom (text/number). Click sur la
// cellule → input plein-largeur, blur ou Enter → sauvegarde via onSave.
// L'event onClick stoppe la propagation pour ne pas ouvrir la fiche détail.
function CustomFieldCell({ row, field, onSave }) {
  const initial = row[field.column_name]
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(initial == null ? '' : String(initial))
  useEffect(() => { setLocal(initial == null ? '' : String(initial)) }, [initial])

  function commit() {
    setEditing(false)
    const trimmed = String(local).trim()
    const currentStr = initial == null ? '' : String(initial)
    if (trimmed === currentStr) return
    if (field.type === 'number') {
      if (trimmed === '') return onSave(null)
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return // invalide → no-op
      onSave(n)
    } else {
      onSave(trimmed === '' ? null : trimmed)
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={field.type === 'number' ? 'number' : 'text'}
        step={field.type === 'number' ? `0.${'0'.repeat(Math.max(0, (field.decimals ?? 0) - 1))}1` : undefined}
        value={local}
        onChange={e => setLocal(e.target.value)}
        onClick={e => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { setEditing(false); setLocal(initial == null ? '' : String(initial)) }
        }}
        className="w-full bg-white border border-brand-400 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    )
  }

  let display
  if (initial == null || initial === '') display = <span className="text-slate-300">—</span>
  else if (field.type === 'number') {
    const n = Number(initial)
    display = Number.isFinite(n)
      ? <span className="tabular-nums">{n.toLocaleString('fr-CA', { minimumFractionDigits: field.decimals ?? 0, maximumFractionDigits: field.decimals ?? 0 })}</span>
      : <span className="text-slate-300">—</span>
  } else {
    display = <span>{initial}</span>
  }

  return (
    <div
      onClick={e => { e.stopPropagation(); setEditing(true) }}
      className="cursor-text hover:bg-slate-100 rounded px-1 -mx-1 py-0.5 transition-colors"
      title="Cliquer pour modifier"
    >
      {display}
    </div>
  )
}

const PROJECT_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']

function ProjectForm({ initial = {}, companies = [], onSave, onClose }) {
  const [form, setForm] = useState({
    name: '', company_id: '', contact_id: '',
    type: '', status: 'Ouvert', probability: 50, value_cad: '',
    monthly_cad: '', nb_greenhouses: 0, close_date: '', notes: '',
    refusal_reason: '', ...initial
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
        <div className="col-span-2">
          <label className="label">Nom du projet *</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" required />
        </div>
        <div>
          <label className="label">Entreprise</label>
          <LinkedRecordField
            name="pipeline_company_id"
            value={form.company_id}
            options={companies}
            labelFn={c => c.name}
            placeholder="Entreprise"
            onChange={v => setForm(f => ({ ...f, company_id: v }))}
          />
        </div>
        <div>
          <label className="label">Type</label>
          <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="select">
            <option value="">—</option>
            {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Statut</label>
          <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} className="select">
            <option value="Ouvert">Ouvert</option>
            <option value="Gagné">Gagné</option>
            <option value="Perdu">Perdu</option>
          </select>
        </div>
        <div>
          <label className="label">Probabilité (%)</label>
          <input type="range" min="0" max="100" step="5" value={form.probability}
            onChange={e => setForm(f => ({ ...f, probability: parseInt(e.target.value) }))}
            className="w-full mt-1"
          />
          <div className="text-center text-sm font-medium text-brand-600">{form.probability}%</div>
        </div>
        <div>
          <label className="label">Date de clôture prévue</label>
          <input type="date" value={form.close_date} onChange={e => setForm(f => ({ ...f, close_date: e.target.value }))} className="input" />
        </div>
        {form.status === 'Perdu' && (
          <div className="col-span-2">
            <label className="label">Raison du refus</label>
            <input value={form.refusal_reason} onChange={e => setForm(f => ({ ...f, refusal_reason: e.target.value }))} className="input" />
          </div>
        )}
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="input" rows={3} />
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
  const { fields: customFields, reload: reloadCustomFields } = useCustomFields('projects')
  const [customFieldModal, setCustomFieldModal] = useState(null) // { editing: field|null }
  const confirm = useConfirm()
  const { addToast } = useToast()

  const customFieldsByColumn = useMemo(() => {
    const m = new Map()
    for (const f of customFields) m.set(f.column_name, f)
    return m
  }, [customFields])

  async function handleDeleteCustomField(field) {
    if (!(await confirm(`Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.`))) return
    try {
      await api.customFields.delete(field.id)
      addToast({ message: 'Champ supprimé', type: 'success' })
      await reloadCustomFields()
      load() // recharge les projets pour refléter la perte de la colonne
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.projects.list({ limit, page }),
      setProjects, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => {})
  }, [])

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

  // Stats toujours calculées sur tous les projets
  const open   = useMemo(() => projects.filter(p => p.status === 'Ouvert'), [projects])
  const won    = useMemo(() => projects.filter(p => p.status === 'Gagné'), [projects])
  const openValue    = useMemo(() => open.reduce((s, p) => s + (p.value_cad || 0), 0), [open])
  const weightedValue = useMemo(() => open.reduce((s, p) => s + (p.value_cad || 0) * (p.probability || 0) / 100, 0), [open])
  const wonValue = useMemo(() => won.reduce((s, p) => s + (p.value_cad || 0), 0), [won])

  const COLUMNS = useMemo(() => TABLE_COLUMN_META.projects.map(meta => ({
    ...meta,
    render:
      meta.id === 'name' ? row => (
        <div>
          <div className="font-medium text-slate-900">{row.name}</div>
          {row.type && <div className="text-xs text-slate-400">{row.type}</div>}
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
  })), [])

  // Cellule éditable inline pour un champ custom : clic → input, blur → save.
  const updateProjectField = useCallback(async (projectId, columnName, value) => {
    try {
      await api.projects.update(projectId, { [columnName]: value })
      // Patch optimiste — évite un reload complet à chaque blur.
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, [columnName]: value } : p))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }, [addToast])

  // Colonnes finales = colonnes hardcodées + champs custom (text/number).
  const COLUMNS_WITH_CUSTOM = useMemo(() => {
    const customCols = customFields.map(f => ({
      id: f.column_name,
      label: f.name,
      field: f.column_name,
      type: f.type === 'number' ? 'number' : 'text',
      groupable: true,
      sortable: true,
      filterable: true,
      render: row => (
        <CustomFieldCell
          row={row}
          field={f}
          onSave={(v) => updateProjectField(row.id, f.column_name, v)}
        />
      ),
    }))
    return [...COLUMNS, ...customCols]
  }, [COLUMNS, customFields, updateProjectField])

  async function handleCreate(form) { await api.projects.create(form); load() }
  async function handleUpdate(form) { await api.projects.update(editProject.id, form); setEditProject(null); load() }

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
            <TableConfigModal table="projects" />
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus size={16} /> Nouveau projet
            </button>
          </div>
        </div>

        {/* Barre de stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="card p-4">
            <div className="text-xs text-slate-500 font-medium">Pipeline ouvert</div>
            <div className="text-xl font-bold text-slate-900 mt-1">{fmtCad(openValue)}</div>
            <div className="text-xs text-slate-400">{open.length} projets</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-slate-500 font-medium">Valeur pondérée</div>
            <div className="text-xl font-bold text-brand-600 mt-1">{fmtCad(weightedValue)}</div>
            <div className="text-xs text-slate-400">Probabilité ajustée</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-slate-500 font-medium">Total gagné</div>
            <div className="text-xl font-bold text-green-600 mt-1">{fmtCad(wonValue)}</div>
            <div className="text-xs text-slate-400">{won.length} projets</div>
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
          columns={COLUMNS_WITH_CUSTOM}
          data={displayedProjects}
          loading={loading}
          onRowClick={row => navigate(`/projects/${row.id}`)}
          searchFields={['name', 'company_name', 'type', 'vendeur_label', 'nom_du_vendeur']}
          initialGroupBy={monthFilter ? 'status' : null}
          forceAllView={!!monthFilter || !!createdMonthFilter}
          disabledColumns={disabledCols}
          onAddCustomField={() => setCustomFieldModal({ editing: null })}
          customFieldsByColumn={customFieldsByColumn}
          onEditCustomField={(field) => setCustomFieldModal({ editing: field })}
          onDeleteCustomField={handleDeleteCustomField}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau projet" size="lg">
        <ProjectForm companies={companies} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <Modal isOpen={!!editProject} onClose={() => setEditProject(null)} title="Modifier le projet" size="lg">
        {editProject && (
          <ProjectForm initial={editProject} companies={companies} onSave={handleUpdate} onClose={() => setEditProject(null)} />
        )}
      </Modal>

      <CustomFieldModal
        isOpen={!!customFieldModal}
        onClose={() => setCustomFieldModal(null)}
        erpTable="projects"
        editing={customFieldModal?.editing || null}
        onSaved={() => { reloadCustomFields(); load() }}
      />
    </Layout>
  )
}
