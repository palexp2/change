import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, X, RefreshCw, Database } from 'lucide-react'
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
import { useSyncStatus } from '../lib/useSyncStatus.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
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

function AirtableSyncButton({ onSynced }) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState(null)
  const [bases, setBases] = useState([])
  const [tables, setTables] = useState([])
  const [baseId, setBaseId] = useState('')
  const [tableId, setTableId] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [erpColumns, setErpColumns] = useState(null) // null = not loaded; [] = loaded
  const [frozenCols, setFrozenCols] = useState(null) // null = not loaded
  const [columnFilter, setColumnFilter] = useState('')
  const { status: syncStatus } = useSyncStatus(3000)
  const syncing = !!syncStatus?.projets?.running

  useEffect(() => {
    api.connectors.list().then(d => {
      const cfg = d.projets_sync || {}
      setConfig(cfg)
      if (cfg.base_id) setBaseId(cfg.base_id)
      if (cfg.projects_table_id) setTableId(cfg.projects_table_id)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    if (bases.length === 0) {
      setLoading(true)
      setError(null)
      api.airtable.bases()
        .then(b => setBases(b || []))
        .catch(e => setError(e.message || 'Erreur de chargement'))
        .finally(() => setLoading(false))
    }
    if (erpColumns === null) {
      api.airtable.erpTableColumns('projects')
        .then(cols => setErpColumns((cols || []).slice().sort((a, b) => a.name.localeCompare(b.name))))
        .catch(() => setErpColumns([]))
    }
    if (frozenCols === null) {
      api.airtable.frozenColumns('projects')
        .then(rows => setFrozenCols(new Set((rows || []).map(r => r.column_name))))
        .catch(() => setFrozenCols(new Set()))
    }
  }, [open, bases.length, erpColumns, frozenCols])

  async function toggleFrozen(columnName) {
    const next = new Set(frozenCols || [])
    const willFreeze = !next.has(columnName)
    // optimistic update
    if (willFreeze) next.add(columnName); else next.delete(columnName)
    setFrozenCols(next)
    try {
      await api.airtable.setFrozenColumn('projects', columnName, willFreeze)
    } catch {
      // revert on failure
      const revert = new Set(frozenCols || [])
      setFrozenCols(revert)
    }
  }

  useEffect(() => {
    if (!baseId) { setTables([]); return }
    api.airtable.tables(baseId).then(t => setTables(t || [])).catch(() => setTables([]))
  }, [baseId])

  // When sync transitions from running -> done, refresh config + parent data
  const wasSyncing = useRef(false)
  useEffect(() => {
    if (syncing) { wasSyncing.current = true; return }
    if (wasSyncing.current) {
      wasSyncing.current = false
      api.connectors.list().then(d => setConfig(d.projets_sync || {})).catch(() => {})
      onSynced?.()
    }
  }, [syncing, onSynced])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await api.airtable.saveConfig('projets', {
        base_id: baseId,
        projects_table_id: tableId,
        field_map_projects: {},
      })
      const d = await api.connectors.list()
      setConfig(d.projets_sync || {})
    } catch (e) { setError(e.message || 'Erreur enregistrement') }
    finally { setSaving(false) }
  }

  async function handleSync() {
    if (!baseId || !tableId) return
    setError(null)
    try { await api.airtable.sync('projets') }
    catch (e) { setError(e.message || 'Erreur sync') }
  }

  const configured = !!(config?.base_id && config?.projects_table_id)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary flex items-center gap-2"
        title={configured
          ? (config.last_synced_at ? `Dernière sync : ${fmtDate(config.last_synced_at)}` : 'Configurée')
          : 'Synchronisation Airtable non configurée'}
      >
        <Database size={15} className="text-indigo-500" />
        <span>Sync Airtable</span>
        {syncing
          ? <RefreshCw size={13} className="animate-spin text-amber-500" />
          : !configured && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
      </button>

      <Modal isOpen={open} onClose={() => setOpen(false)} title="Synchronisation Airtable" size="lg">
        <div className="space-y-4">
          <div className="text-xs text-slate-500 flex items-center gap-2">
            {configured ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span>{config.last_synced_at ? `Dernière sync : ${fmtDate(config.last_synced_at)}` : 'Configurée'}</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-amber-600">Non configurée</span>
              </>
            )}
            {syncing && <span className="text-amber-600 font-medium animate-pulse ml-2">Synchronisation en cours…</span>}
          </div>

          {loading ? (
            <p className="text-xs text-slate-400">Chargement…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="label text-xs">Base Airtable</label>
                  <select className="input text-sm" value={baseId} onChange={e => { setBaseId(e.target.value); setTableId('') }}>
                    <option value="">— Sélectionner —</option>
                    {bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label text-xs">Table projets</label>
                  <select className="input text-sm" value={tableId} onChange={e => setTableId(e.target.value)} disabled={!baseId}>
                    <option value="">— Sélectionner —</option>
                    {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button onClick={handleSave} disabled={saving || !baseId || !tableId} className="btn-secondary btn-sm">
                  {saving ? 'Enregistrement…' : 'Enregistrer'}
                </button>
                <button onClick={handleSync} disabled={syncing || !configured} className="btn-primary btn-sm flex items-center gap-1.5">
                  <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
                  {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
                </button>
              </div>
            </>
          )}

          <div className="pt-3 border-t border-slate-100">
            <div className="flex items-baseline justify-between mb-1">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Champs de la table <code className="font-mono text-slate-700">projects</code> (DB ERP)
              </p>
              {erpColumns && (
                <span className="text-[11px] text-slate-400">
                  {erpColumns.length} champs
                  {frozenCols?.size > 0 && <> · <span className="text-amber-600 font-medium">{frozenCols.size} gelés</span></>}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mb-2">
              Décoche un champ pour qu'il ne soit plus mis à jour par Airtable — sa valeur vivra uniquement dans la DB.
            </p>
            {erpColumns && erpColumns.length > 10 && (
              <input
                type="text"
                value={columnFilter}
                onChange={e => setColumnFilter(e.target.value)}
                placeholder="Rechercher un champ…"
                className="input text-xs mb-2"
              />
            )}
            {erpColumns === null ? (
              <p className="text-xs text-slate-400">Chargement…</p>
            ) : erpColumns.length === 0 ? (
              <p className="text-xs text-slate-400">Aucun champ trouvé.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 max-h-64 overflow-y-auto">
                {erpColumns
                  .filter(c => !columnFilter || c.name.toLowerCase().includes(columnFilter.toLowerCase()))
                  .map(c => {
                    const frozen = frozenCols?.has(c.name)
                    const synced = !frozen
                    return (
                      <label
                        key={c.name}
                        className={`flex items-center gap-2 text-xs py-1 px-1 rounded cursor-pointer hover:bg-slate-100 ${frozen ? 'opacity-60' : ''}`}
                        title={frozen ? 'Gelé — non mis à jour par Airtable' : 'Mis à jour par Airtable'}
                      >
                        <input
                          type="checkbox"
                          checked={synced}
                          disabled={frozenCols === null}
                          onChange={() => toggleFrozen(c.name)}
                          className="accent-indigo-500"
                        />
                        <span className={`font-mono flex-1 truncate ${frozen ? 'line-through text-slate-400' : 'text-slate-700'}`}>{c.name}</span>
                        <span className="text-[10px] text-slate-400">{c.type}</span>
                      </label>
                    )
                  })}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}

export default function Pipeline() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const monthFilter = searchParams.get('month') // e.g. "2026-03"
  const [projects, setProjects] = useState([])
  const [companies, setCompanies] = useState([])
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
    api.companies.lookup().then(setCompanies).catch(() => {})
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
      meta.id === 'orders' ? row => {
        if (!row.orders?.length) return <span className="text-slate-400">—</span>
        return (
          <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
            {row.orders.map(o => (
              <Link key={o.id} to={`/orders/${o.id}`}
                className="font-mono text-xs text-indigo-600 hover:underline bg-indigo-50 px-1.5 py-0.5 rounded">
                #{o.order_number}
              </Link>
            ))}
          </div>
        )
      } :
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
            <AirtableSyncButton onSynced={load} />
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
          searchFields={['name', 'company_name', 'type']}
          initialGroupBy={monthFilter ? 'status' : null}
          forceAllView={!!monthFilter}
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
    </Layout>
  )
}
