import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Database, ChevronDown, ChevronRight, Plus, Pencil, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

function bool(row, key) {
  return row[key] ? <span className="text-green-600">✓</span> : <span className="text-slate-300">—</span>
}

function money(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(n)
}

function num(n, digits = 2) {
  if (n == null) return '—'
  return Number(n).toLocaleString('fr-CA', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}

const RENDERS_PAIES = {
  period_end: row => <span className="text-slate-700">{fmtDate(row.period_end)}</span>,
  timesheets_deadline: row => <span className="text-slate-500">{row.timesheets_deadline || '—'}</span>,
  total_with_charges_and_reimb: row => <span className="font-medium">{money(row.total_with_charges_and_reimb)}</span>,
  total_regular_amount: row => <span className="text-slate-700">{money(row.total_regular_amount)}</span>,
  total_regular_hours: row => <span className="text-slate-700">{num(row.total_regular_hours)}</span>,
  timesheets_sent: row => bool(row, 'timesheets_sent'),
  includes_hourly: row => bool(row, 'includes_hourly'),
  includes_mileage: row => bool(row, 'includes_mileage'),
  includes_expense_reimb: row => bool(row, 'includes_expense_reimb'),
  includes_paid_leave: row => bool(row, 'includes_paid_leave'),
  includes_holiday_hours: row => bool(row, 'includes_holiday_hours'),
  includes_sales_commissions: row => bool(row, 'includes_sales_commissions'),
}

const COLUMNS_PAIES = TABLE_COLUMN_META.paies.map(meta => ({ ...meta, render: RENDERS_PAIES[meta.id] }))

const RENDERS_PAIE_ITEMS = {
  employee_name:           row => <span>{row.first_name} {row.last_name}</span>,
  accounting_department:   row => <span className="text-slate-500">{row.accounting_department || '—'}</span>,
  hourly_rate:             row => <span className="tabular-nums">{money(row.hourly_rate)}</span>,
  regular_hours:           row => <span className="tabular-nums">{num(row.regular_hours)}</span>,
  holiday_hours:           row => <span className="tabular-nums">{num(row.holiday_hours)}</span>,
  vacation:                row => <span className="tabular-nums">{money(row.vacation)}</span>,
  commission:              row => <span className="tabular-nums">{money(row.commission)}</span>,
  expense_reimb:           row => <span className="tabular-nums">{money(row.expense_reimb)}</span>,
  period_end:              row => <span className="text-slate-700">{fmtDate(row.period_end)}</span>,
}

const COLUMNS_PAIE_ITEMS = TABLE_COLUMN_META.paie_items
  .filter(meta => meta.id !== 'period_end')
  .map(meta => ({ ...meta, render: RENDERS_PAIE_ITEMS[meta.id] }))

function SyncPanel({ onSynced }) {
  const [open, setOpen] = useState(false)
  const [cfgPaies, setCfgPaies] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.paies.syncConfig().then(setCfgPaies).catch(() => {})
  }, [])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      await api.paies.sync()
      await api.paies.syncItems()
      const start = Date.now()
      while (Date.now() - start < 90000) {
        await new Promise(r => setTimeout(r, 1500))
        const status = await api.connectors.syncStatus().catch(() => ({}))
        if (!status?.paies && !status?.paie_items) break
      }
      const cfg = await api.paies.syncConfig()
      setCfgPaies(cfg)
      onSynced?.()
    } catch (e) { setError(e.message || 'Erreur sync') }
    finally { setSyncing(false) }
  }

  const configured = !!(cfgPaies?.base_id && cfgPaies?.table_id)

  return (
    <div className="card mb-4 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Database size={15} className="text-brand-500" />
        <span className="font-medium">Synchronisation Airtable</span>
        {configured ? (
          <span className="text-xs text-slate-400 ml-2">
            {cfgPaies.last_synced_at ? `Dernière sync: ${fmtDate(cfgPaies.last_synced_at)}` : 'Configurée'}
          </span>
        ) : (
          <span className="text-xs text-amber-600 ml-2">Non configurée</span>
        )}
      </button>
      {open && (
        <div className="border-t border-slate-200 p-4 bg-slate-50 space-y-3">
          <p className="text-xs text-slate-500">
            Les tables Paies et Items de paie sont pré-configurées sur la base Employés. Le mappage des champs est détecté automatiquement au premier import.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button onClick={handleSync} disabled={syncing} className="btn-primary btn-sm flex items-center gap-1.5">
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Synchronisation…' : 'Synchroniser Paies + Items'}
          </button>
        </div>
      )}
    </div>
  )
}

const STATUSES = ['Non débuté', 'En cours', 'Complété', 'Envoyé', 'Envoyés']

const EMPTY_PAIE = {
  number: '', period_end: '', status: 'Non débuté',
  nb_holiday_days: 0, total_with_charges_and_reimb: '',
  timesheets_deadline: '', timesheets_sent: 0,
  includes_hourly: 1, includes_mileage: 0, includes_expense_reimb: 1,
  includes_paid_leave: 0, includes_holiday_hours: 0, includes_sales_commissions: 0,
}

function PaieForm({ paie, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(() => {
    if (!paie) return { ...EMPTY_PAIE }
    return {
      ...EMPTY_PAIE,
      ...paie,
      number: paie.number ?? '',
      nb_holiday_days: paie.nb_holiday_days ?? 0,
      total_with_charges_and_reimb: paie.total_with_charges_and_reimb ?? '',
      timesheets_deadline: paie.timesheets_deadline || '',
    }
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  const chk = k => e => setForm(p => ({ ...p, [k]: e.target.checked ? 1 : 0 }))

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const payload = {
        ...form,
        number: form.number === '' ? null : Number(form.number),
        nb_holiday_days: form.nb_holiday_days === '' ? null : Number(form.nb_holiday_days),
        total_with_charges_and_reimb: form.total_with_charges_and_reimb === '' ? null : Number(form.total_with_charges_and_reimb),
      }
      if (paie) await api.paies.update(paie.id, payload)
      else await api.paies.create(payload)
      onSaved()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.paies.delete(paie.id)
      onDeleted()
    } catch (err) { setError(err.message); setDeleting(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Période</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Fin de période *</label>
            <input type="date" value={form.period_end || ''} onChange={f('period_end')} className="input" required />
          </div>
          <div>
            <label className="label">Numéro</label>
            <input type="number" value={form.number} onChange={f('number')} className="input" />
          </div>
          <div>
            <label className="label">Statut</label>
            <select value={form.status || ''} onChange={f('status')} className="input">
              {STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Nombre de congés fériés</label>
            <input type="number" step="1" value={form.nb_holiday_days ?? ''} onChange={f('nb_holiday_days')} className="input" />
          </div>
          <div>
            <label className="label">Date limite correction FdT</label>
            <input value={form.timesheets_deadline || ''} onChange={f('timesheets_deadline')} className="input" placeholder="ex. Mardi 11h AM" />
          </div>
          <div>
            <label className="label">Total paie (optionnel)</label>
            <input type="number" step="0.01" value={form.total_with_charges_and_reimb ?? ''} onChange={f('total_with_charges_and_reimb')} className="input" />
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Inclusions</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_hourly} onChange={chk('includes_hourly')} className="rounded" /> Heures employés horaires
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_mileage} onChange={chk('includes_mileage')} className="rounded" /> Kilométrage
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_expense_reimb} onChange={chk('includes_expense_reimb')} className="rounded" /> Remboursement de dépenses
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_paid_leave} onChange={chk('includes_paid_leave')} className="rounded" /> Congés payés
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_holiday_hours} onChange={chk('includes_holiday_hours')} className="rounded" /> Heures fériées
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_sales_commissions} onChange={chk('includes_sales_commissions')} className="rounded" /> Commissions vendeurs
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 col-span-2 pt-1 border-t border-slate-100 mt-1">
            <input type="checkbox" checked={!!form.timesheets_sent} onChange={chk('timesheets_sent')} className="rounded" /> Feuilles de temps envoyées
          </label>
        </div>
      </div>

      <div className="flex justify-between items-center pt-2">
        <div>
          {paie && (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleDelete} disabled={deleting} className="btn-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded font-medium">
                  {deleting ? 'Suppression…' : 'Confirmer'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn-sm text-slate-500 px-2 py-1">Annuler</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1">
                <Trash2 size={13} /> Supprimer
              </button>
            )
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </div>
    </form>
  )
}

function PaieDetail({ paie, onEdit, onDeleted, onClose }) {
  const { addToast } = useToast()
  const [detail, setDetail] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  useEffect(() => {
    api.paies.get(paie.id).then(setDetail).catch(() => {})
  }, [paie.id])

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.paies.delete(paie.id)
      onDeleted()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
      setDeleting(false)
    }
  }

  async function handleImport() {
    setImporting(true)
    setImportResult(null)
    try {
      const result = await api.paies.importTimesheets(paie.id)
      setImportResult(result)
      const fresh = await api.paies.get(paie.id)
      setDetail(fresh)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setImporting(false)
    }
  }

  if (!detail) return <p className="text-sm text-slate-400">Chargement…</p>

  const totalHeuresReg = detail.items.reduce((s, i) => s + (i.regular_hours || 0), 0)
  const totalMontantReg = detail.items.reduce((s, i) => s + ((i.regular_hours || 0) * (i.hourly_rate || 0)), 0)
  const totalCommissions = detail.items.reduce((s, i) => s + (i.commission || 0), 0)
  const totalRemb = detail.items.reduce((s, i) => s + (i.expense_reimb || 0), 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-xs text-slate-500">Période</div>
          <div className="font-medium">
            {detail.period_start ? `${fmtDate(detail.period_start)} → ` : ''}
            {fmtDate(detail.period_end)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Statut</div>
          <div className="font-medium">{detail.status || '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Items</div>
          <div className="font-medium">{detail.items.length}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Total paie (Airtable)</div>
          <div className="font-medium">{money(detail.total_with_charges_and_reimb)}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 text-sm border-t border-slate-200 pt-3">
        <div>
          <div className="text-xs text-slate-500">Heures régulières</div>
          <div className="font-medium">{num(totalHeuresReg)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">$ heures régulières</div>
          <div className="font-medium">{money(totalMontantReg)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Commissions</div>
          <div className="font-medium">{money(totalCommissions)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Remb. dépenses</div>
          <div className="font-medium">{money(totalRemb)}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm border-t border-slate-200 pt-3">
        <button
          onClick={handleImport}
          disabled={importing}
          className="btn-secondary flex items-center gap-1.5 text-sm"
          title="Recalcule les heures depuis les feuilles de temps. Les employés avec hours_per_week > 0 conservent leurs heures régulières (le diff va en banque d'heures). Les autres voient leurs heures régulières écrasées."
        >
          <RefreshCw size={13} className={importing ? 'animate-spin' : ''} />
          {importing ? 'Import en cours…' : 'Resynchroniser avec les feuilles de temps'}
        </button>
        {importResult && (
          <span className="text-xs text-slate-500">
            {importResult.results?.length || 0} employé(s) traité(s) — période {importResult.period_start} → {importResult.period_end}
          </span>
        )}
      </div>
      {importResult?.results?.some(r => r.skipped === 'no_user_link') && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Certains employés n'ont pas d'utilisateur lié (impossible d'importer leurs feuilles de temps).
          Lier dans Paramètres → Utilisateurs.
        </div>
      )}

      <DataTable
        table="paie_items"
        columns={COLUMNS_PAIE_ITEMS}
        data={detail.items}
        searchFields={['first_name', 'last_name', 'accounting_department']}
      />

      <div className="flex justify-between items-center gap-2">
        <div>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button onClick={handleDelete} disabled={deleting} className="text-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded font-medium">
                {deleting ? 'Suppression…' : 'Confirmer la suppression'}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm text-slate-500 px-2 py-1">Annuler</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1.5">
              <Trash2 size={13} /> Supprimer
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => onEdit(detail)} className="btn-secondary flex items-center gap-1.5">
            <Pencil size={13} /> Modifier
          </button>
          <button onClick={onClose} className="btn-primary">Fermer</button>
        </div>
      </div>
    </div>
  )
}

export default function Paies() {
  const [paies, setPaies] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.paies.list({ limit: 500 })
      setPaies(data || [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setEditing(null)
    setShowForm(true)
  }

  function openEdit(paie) {
    setSelected(null)
    setEditing(paie)
    setShowForm(true)
  }

  function handleSaved() {
    setShowForm(false)
    setEditing(null)
    load()
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Paies</h1>
          <div className="flex items-center gap-2">
            <TableConfigModal table="paies" />
            <button onClick={openCreate} className="btn-primary flex items-center gap-2">
              <Plus size={15} /> Nouvelle paie
            </button>
          </div>
        </div>

        <SyncPanel onSynced={load} />

        <DataTable
          table="paies"
          columns={COLUMNS_PAIES}
          data={paies}
          loading={loading}
          onRowClick={row => setSelected(row)}
          searchFields={['status', 'number']}
        />
      </div>

      <Modal
        isOpen={!!selected}
        title={selected ? `Paie — ${fmtDate(selected.period_end)}${selected.number ? ` (#${selected.number})` : ''}` : ''}
        onClose={() => setSelected(null)}
        size="xl"
      >
        {selected && <PaieDetail paie={selected} onEdit={openEdit} onClose={() => setSelected(null)} onDeleted={() => { setSelected(null); load() }} />}
      </Modal>

      <Modal
        isOpen={showForm}
        title={editing ? `Paie — ${fmtDate(editing.period_end)}${editing.number ? ` (#${editing.number})` : ''}` : 'Nouvelle paie'}
        onClose={() => { setShowForm(false); setEditing(null) }}
        size="lg"
      >
        <PaieForm
          paie={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSaved={handleSaved}
          onDeleted={handleSaved}
        />
      </Modal>
    </Layout>
  )
}
