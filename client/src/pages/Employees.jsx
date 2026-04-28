import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, RefreshCw, Database, ChevronDown, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

function bool(row, key) {
  return row[key] ? <span className="text-green-600">✓</span> : <span className="text-slate-300">—</span>
}

const RENDERS = {
  full_name: row => (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-semibold text-xs flex-shrink-0">
        {(row.first_name?.[0] || '') + (row.last_name?.[0] || '')}
      </div>
      <span className="font-medium text-slate-900">{row.first_name} {row.last_name}</span>
    </div>
  ),
  active: row => bool(row, 'active'),
  is_salesperson: row => bool(row, 'is_salesperson'),
  is_consultant: row => bool(row, 'is_consultant'),
  group_insurance: row => bool(row, 'group_insurance'),
  office_key: row => bool(row, 'office_key'),
  address_verified: row => bool(row, 'address_verified'),
  hire_date: row => <span className="text-slate-500">{fmtDate(row.hire_date)}</span>,
  end_date: row => <span className="text-slate-500">{fmtDate(row.end_date)}</span>,
  birth_date: row => <span className="text-slate-500">{fmtDate(row.birth_date)}</span>,
  last_raise_date: row => <span className="text-slate-500">{fmtDate(row.last_raise_date)}</span>,
  email_personal: row => <span className="text-slate-500">{row.email_personal || '—'}</span>,
  phone_personal: row => <span className="text-slate-500">{row.phone_personal || '—'}</span>,
}

const COLUMNS = TABLE_COLUMN_META.employees.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function NewEmployeeModal({ onClose, onCreated }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const created = await api.employees.create({ first_name: firstName.trim(), last_name: lastName.trim(), active: 1 })
      onCreated(created)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Prénom *</label>
          <input value={firstName} onChange={e => setFirstName(e.target.value)} className="input" required autoFocus />
        </div>
        <div>
          <label className="label">Nom *</label>
          <input value={lastName} onChange={e => setLastName(e.target.value)} className="input" required />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Les autres informations s'éditent directement sur la fiche de l'employé (autosave).
      </p>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving || !firstName.trim() || !lastName.trim()} className="btn-primary">
          {saving ? 'Création…' : 'Créer et ouvrir'}
        </button>
      </div>
    </form>
  )
}

function SyncPanel({ onSynced }) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState(null)
  const [bases, setBases] = useState([])
  const [tables, setTables] = useState([])
  const [baseId, setBaseId] = useState('')
  const [tableId, setTableId] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.employees.syncConfig().then(setConfig).catch(() => {})
  }, [])

  useEffect(() => {
    if (!open || bases.length > 0) return
    setLoading(true)
    setError(null)
    api.airtable.bases()
      .then(basesList => {
        setBases(basesList || [])
        if (config?.base_id) setBaseId(config.base_id)
        if (config?.table_id) setTableId(config.table_id)
      })
      .catch(e => setError(e.message || 'Erreur de chargement'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!baseId) { setTables([]); return }
    api.airtable.tables(baseId).then(t => setTables(t || [])).catch(() => setTables([]))
  }, [baseId])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await api.employees.saveSyncConfig({ base_id: baseId, table_id: tableId })
      const cfg = await api.employees.syncConfig()
      setConfig(cfg)
    } catch (e) { setError(e.message || 'Erreur enregistrement') }
    finally { setSaving(false) }
  }

  async function handleSync() {
    if (!baseId || !tableId) return
    setSyncing(true)
    setError(null)
    try {
      await api.employees.sync()
      const start = Date.now()
      while (Date.now() - start < 60000) {
        await new Promise(r => setTimeout(r, 1500))
        const status = await api.connectors.syncStatus().catch(() => ({}))
        if (!status?.employees) break
      }
      const cfg = await api.employees.syncConfig()
      setConfig(cfg)
      onSynced?.()
    } catch (e) { setError(e.message || 'Erreur sync') }
    finally { setSyncing(false) }
  }

  const configured = !!(config?.base_id && config?.table_id)

  return (
    <div className="card mb-4 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Database size={15} className="text-indigo-500" />
        <span className="font-medium">Synchronisation Airtable</span>
        {configured ? (
          <span className="text-xs text-slate-400 ml-2">
            {config.last_synced_at ? `Dernière sync: ${fmtDate(config.last_synced_at)}` : 'Configurée'}
          </span>
        ) : (
          <span className="text-xs text-amber-600 ml-2">Non configurée</span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-200 p-4 space-y-3 bg-slate-50">
          {loading ? (
            <p className="text-xs text-slate-400">Chargement…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label text-xs">Base Airtable</label>
                  <select className="input text-sm" value={baseId} onChange={e => { setBaseId(e.target.value); setTableId('') }}>
                    <option value="">— Sélectionner —</option>
                    {bases.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label text-xs">Table</label>
                  <select className="input text-sm" value={tableId} onChange={e => setTableId(e.target.value)} disabled={!baseId}>
                    <option value="">— Sélectionner —</option>
                    {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Le mappage des champs (prénom, nom, courriels, téléphones, dates, matricule) est détecté automatiquement au premier import.
              </p>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex items-center gap-2 pt-1">
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
        </div>
      )}
    </div>
  )
}

export default function Employees() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.employees.list({ limit: 500 })
      setEmployees(data || [])
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally { setLoading(false) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  function handleCreated(emp) {
    setShowNew(false)
    navigate(`/employees/${emp.id}`)
  }

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Employés</h1>
          <div className="flex items-center gap-2">
            <TableConfigModal table="employees" />
            <button onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-2">
              <Plus size={15} /> Nouvel employé
            </button>
          </div>
        </div>

        <SyncPanel onSynced={load} />

        <DataTable
          table="employees"
          columns={COLUMNS}
          data={employees}
          loading={loading}
          onRowClick={row => navigate(`/employees/${row.id}`)}
          searchFields={['first_name', 'last_name', 'matricule', 'email_work', 'email_personal']}
        />
      </div>

      <Modal isOpen={showNew} title="Nouvel employé" onClose={() => setShowNew(false)}>
        <NewEmployeeModal onClose={() => setShowNew(false)} onCreated={handleCreated} />
      </Modal>
    </Layout>
  )
}
