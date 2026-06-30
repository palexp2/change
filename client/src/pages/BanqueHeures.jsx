import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Wallet, Plus, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useAuth } from '../lib/auth.jsx'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

function fmtHours(h) {
  if (h == null || !Number.isFinite(Number(h))) return '—'
  const n = Number(h)
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(2)} h`
}

export default function BanqueHeures() {
  const { user } = useAuth()
  const isHR = ['admin', 'rh'].includes(user?.role)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [details, setDetails] = useState({}) // employeeId → { entries, balance_hours }
  const [addFor, setAddFor] = useState(null) // employeeId being added
  const confirm = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.hourBank.list()
      setRows(r.data || [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Aggregated balances — recharger sur tout changement d'entrée pour mettre à jour les soldes.
  useRealtimeChannel('hour_bank_entry:list', () => { load() })

  // Charge l'historique d'un employé à la demande (au dépliage de sa ligne).
  const loadEmployee = useCallback(async (employeeId) => {
    if (details[employeeId]) return
    const d = await api.hourBank.forEmployee(employeeId)
    setDetails(s => ({ ...s, [employeeId]: d }))
  }, [details])

  const refreshEmployee = useCallback(async (employeeId) => {
    const d = await api.hourBank.forEmployee(employeeId)
    setDetails(s => ({ ...s, [employeeId]: d }))
    load() // update aggregated balance too
  }, [load])

  const handleDelete = useCallback(async (employeeId, entryId) => {
    if (!(await confirm('Supprimer cet ajustement ?'))) return
    await api.hourBank.deleteEntry(entryId)
    refreshEmployee(employeeId)
  }, [confirm, refreshEmployee])

  const handlePatch = useCallback(async (employeeId, entryId, patch) => {
    await api.hourBank.updateEntry(entryId, patch)
    refreshEmployee(employeeId)
  }, [refreshEmployee])

  const handleAdd = useCallback(async (employeeId, form) => {
    await api.hourBank.create({ ...form, employee_id: employeeId })
    setAddFor(null)
    refreshEmployee(employeeId)
  }, [refreshEmployee])

  // Ligne aplatie pour DataTable : nom complet + champs agrégés.
  const data = useMemo(() => rows.map(r => ({
    ...r,
    employee_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(sans nom)',
  })), [rows])

  const columns = useMemo(() => {
    const renders = {
      employee_name: row => {
        const inner = (
          <>
            {row.employee_name}
            {!row.active && <span className="ml-2 text-xs text-slate-400">(inactif)</span>}
          </>
        )
        // FK → fiche employé (route hrOnly : lien seulement pour admin/rh).
        return isHR
          ? <Link to={`/employees/${row.employee_id}`} onClick={e => e.stopPropagation()} className="font-medium text-brand-600 hover:underline">{inner}</Link>
          : <span className="font-medium text-slate-900">{inner}</span>
      },
      matricule: row => <span className="font-mono text-slate-500">{row.matricule || '—'}</span>,
      entry_count: row => <span className="text-slate-500 tabular-nums">{row.entry_count}</span>,
      balance_hours: row => (
        <span className={`tabular-nums font-semibold ${row.balance_hours > 0 ? 'text-emerald-600' : row.balance_hours < 0 ? 'text-red-600' : 'text-slate-400'}`}>
          {fmtHours(row.balance_hours)}
        </span>
      ),
      vacation_remaining: row => {
        const alw = Number(row.vacation_allowance) || 0
        const rem = Number(row.vacation_remaining) || 0
        // Sans droit annuel configuré, le solde n'a pas de sens → tiret.
        if (alw <= 0 && rem === 0) return <span className="text-slate-300">—</span>
        return (
          <span className={`tabular-nums font-semibold ${rem < 0 ? 'text-red-600' : rem === 0 ? 'text-slate-400' : 'text-emerald-600'}`} title={`${row.vacation_used_days || 0} j pris sur ${alw} j`}>
            {rem} j{rem < 0 ? ' ⚠' : ''}
          </span>
        )
      },
      last_entry_date: row => <span className="text-slate-500">{row.last_entry_date ? fmtDate(row.last_entry_date) : '—'}</span>,
    }
    return TABLE_COLUMN_META.hour_bank.map(meta => ({ ...meta, render: renders[meta.id] }))
  }, [isHR])

  const renderExpanded = useCallback((row) => (
    <div className="px-4 py-3">
      <EntryList
        employeeId={row.employee_id}
        details={details[row.employee_id]}
        isAdding={addFor === row.employee_id}
        onStartAdd={() => setAddFor(row.employee_id)}
        onCancelAdd={() => setAddFor(null)}
        onAdd={handleAdd}
        onPatch={handlePatch}
        onDelete={handleDelete}
        canEdit={isHR}
      />
    </div>
  ), [details, addFor, handleAdd, handlePatch, handleDelete, isHR])

  const onToggleExpand = useCallback((row, willExpand) => {
    if (willExpand) loadEmployee(row.employee_id)
  }, [loadEmployee])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <Wallet size={20} className="text-slate-400" />
          <h1 className="text-2xl font-bold text-slate-900">Banque d'heures</h1>
          <span className="text-sm text-slate-400">— excédent / déficit par employé</span>
        </div>

        <DataTable
          table="hour_bank"
          columns={columns}
          data={data}
          loading={loading}
          rowKey="employee_id"
          renderExpanded={renderExpanded}
          onToggleExpand={onToggleExpand}
          searchFields={['employee_name', 'matricule']}
          emptyState={{ icon: Wallet, title: 'Aucun employé', description: "Aucun solde d'heures à afficher." }}
        />
      </div>
    </Layout>
  )
}

function EntryList({ employeeId, details, isAdding, onStartAdd, onCancelAdd, onAdd, onPatch, onDelete, canEdit }) {
  if (!details) return <div className="text-sm text-slate-400">Chargement…</div>
  const { entries = [] } = details
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          Solde : <span className="font-semibold text-slate-900 tabular-nums">{fmtHours(details.balance_hours)}</span>
        </div>
        {canEdit && !isAdding && (
          <button onClick={onStartAdd} className="text-xs text-brand-600 hover:underline flex items-center gap-1">
            <Plus size={12} /> Ajouter un ajustement manuel
          </button>
        )}
      </div>
      {canEdit && isAdding && <AddForm employeeId={employeeId} onCancel={onCancelAdd} onAdd={onAdd} />}
      {entries.length === 0 ? (
        <div className="text-xs text-slate-400 italic">Aucun ajustement.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400">
              <th className="px-2 py-1 w-28">Date</th>
              <th className="px-2 py-1 w-24 text-right">Heures</th>
              <th className="px-2 py-1 w-28">Source</th>
              <th className="px-2 py-1 w-28">Paie liée</th>
              <th className="px-2 py-1">Notes</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="px-2 py-1">
                  {canEdit
                    ? <input type="date" className={inp + ' w-32'} defaultValue={e.date} onBlur={ev => ev.target.value !== e.date && onPatch(employeeId, e.id, { date: ev.target.value })} />
                    : <span className="text-slate-700">{fmtDate(e.date)}</span>}
                </td>
                <td className="px-2 py-1">
                  {canEdit
                    ? <input type="number" step="0.25" className={inp + ' w-24 text-right'} defaultValue={e.hours} onBlur={ev => Number(ev.target.value) !== Number(e.hours) && onPatch(employeeId, e.id, { hours: Number(ev.target.value) })} />
                    : <span className="text-slate-700 tabular-nums">{fmtHours(e.hours)}</span>}
                </td>
                <td className="px-2 py-1 text-xs">
                  {e.source === 'timesheet_import' ? <span className="text-brand-600">Feuilles de temps</span> : e.source === 'manual' ? <span className="text-slate-500">Manuel</span> : <span className="text-slate-400">{e.source || '—'}</span>}
                </td>
                <td className="px-2 py-1 text-xs text-slate-500">{e.paie_number ? `#${e.paie_number}` : '—'}</td>
                <td className="px-2 py-1">
                  {canEdit
                    ? <input className={inp} defaultValue={e.notes || ''} onBlur={ev => (ev.target.value || '') !== (e.notes || '') && onPatch(employeeId, e.id, { notes: ev.target.value || null })} />
                    : <span className="text-slate-600 text-sm">{e.notes || '—'}</span>}
                </td>
                <td className="px-1">
                  {canEdit && (
                    <button onClick={() => onDelete(employeeId, e.id)} className="p-1 text-slate-300 hover:text-red-500" title="Supprimer"><Trash2 size={13} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function AddForm({ employeeId, onCancel, onAdd }) {
  const { addToast } = useToast()
  const [date, setDate] = useState(localISODate())
  const [hours, setHours] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(e) {
    e.preventDefault()
    const n = parseFloat(hours)
    if (!date || isNaN(n)) return
    setSaving(true)
    try {
      await onAdd(employeeId, { date, hours: n, notes: notes || null })
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="card p-3 bg-white flex items-end gap-2 flex-wrap">
      <div>
        <label className="text-xs text-slate-500">Date</label>
        <input type="date" className={inp + ' w-36'} value={date} onChange={e => setDate(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-slate-500">Heures (+/-)</label>
        <input type="number" step="0.25" className={inp + ' w-28 text-right'} value={hours} onChange={e => setHours(e.target.value)} placeholder="ex: 2.5 ou -1" />
      </div>
      <div className="flex-1 min-w-[200px]">
        <label className="text-xs text-slate-500">Notes</label>
        <input className={inp} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optionnel" />
      </div>
      <button type="submit" disabled={saving || !hours} className="btn-primary btn-sm">{saving ? 'Ajout…' : 'Ajouter'}</button>
      <button type="button" onClick={onCancel} className="btn-secondary btn-sm">Annuler</button>
    </form>
  )
}
