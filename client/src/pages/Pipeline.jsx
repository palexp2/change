import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../lib/api.js'
import { loadProgressive } from '../lib/loadAll.js'
import { Layout } from '../components/Layout.jsx'
import { Badge, projectStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

const PROJECT_TYPES = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']

function ProjectForm({ initial = {}, companies = [], users = [], onSave, onClose }) {
  const [form, setForm] = useState({
    name: '', company_id: '', contact_id: '', assigned_to: '',
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
          <select value={form.company_id} onChange={e => setForm(f => ({ ...f, company_id: e.target.value }))} className="select">
            <option value="">— Sélectionner —</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
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
          <label className="label">Responsable</label>
          <select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))} className="select">
            <option value="">— Non assigné —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Probabilité (%)</label>
          <input type="range" min="0" max="100" step="5" value={form.probability}
            onChange={e => setForm(f => ({ ...f, probability: parseInt(e.target.value) }))}
            className="w-full mt-1"
          />
          <div className="text-center text-sm font-medium text-indigo-600">{form.probability}%</div>
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
  const monthFilter = searchParams.get('month') // e.g. "2026-03"
  const [projects, setProjects] = useState([])
  const [companies, setCompanies] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editProject, setEditProject] = useState(null)

  const load = useCallback(async () => {
    await loadProgressive(
      (page, limit) => api.projects.list({ limit, page }),
      setProjects, setLoading
    )
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.companies.list({ limit: 'all' }).then(r => setCompanies(r.data)).catch(() => {})
    api.admin.listUsers().then(setUsers).catch(() => {})
  }, [])

  // Filtre par mois si présent dans l'URL
  const displayedProjects = useMemo(() => {
    if (!monthFilter) return projects
    return projects.filter(p => {
      const d = p.close_date || p.updated_at || ''
      return d.startsWith(monthFilter)
    })
  }, [projects, monthFilter])

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
        ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-indigo-600 hover:underline">{row.company_name}</Link>
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
      undefined
  })), [])

  async function handleCreate(form) { await api.projects.create(form); load() }
  async function handleUpdate(form) { await api.projects.update(editProject.id, form); setEditProject(null); load() }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Projets</h1>
          </div>
          <div className="flex items-center gap-2">
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
            <div className="text-xl font-bold text-indigo-600 mt-1">{fmtCad(weightedValue)}</div>
            <div className="text-xs text-slate-400">Probabilité ajustée</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-slate-500 font-medium">Total gagné</div>
            <div className="text-xl font-bold text-green-600 mt-1">{fmtCad(wonValue)}</div>
            <div className="text-xs text-slate-400">{won.length} projets</div>
          </div>
        </div>

        {monthFilter && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-700">
            <span>Filtre : {new Date(monthFilter + '-15').toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })} · groupés par statut</span>
            <button onClick={() => setSearchParams({})} className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700">
              <X size={13} /> Effacer
            </button>
          </div>
        )}
        <DataTable
          table="projects"
          columns={COLUMNS}
          data={displayedProjects}
          loading={loading}
          onRowClick={row => navigate(`/projects/${row.id}`)}
          searchFields={['name', 'company_name', 'type', 'assigned_name']}
          initialGroupBy={monthFilter ? 'status' : null}
          forceAllView={!!monthFilter}
        />
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouveau projet" size="lg">
        <ProjectForm companies={companies} users={users} onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>

      <Modal isOpen={!!editProject} onClose={() => setEditProject(null)} title="Modifier le projet" size="lg">
        {editProject && (
          <ProjectForm initial={editProject} companies={companies} users={users} onSave={handleUpdate} onClose={() => setEditProject(null)} />
        )}
      </Modal>
    </Layout>
  )
}
