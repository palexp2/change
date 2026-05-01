import { useState, useEffect, useCallback } from 'react'
import { Wallet, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate } from '../lib/formatDate.js'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

function fmtHours(h) {
  if (h == null || !Number.isFinite(Number(h))) return '—'
  const n = Number(h)
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(2)} h`
}

export default function BanqueHeures() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({}) // employeeId → boolean
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

  async function toggleExpand(employeeId) {
    const next = !expanded[employeeId]
    setExpanded(s => ({ ...s, [employeeId]: next }))
    if (next && !details[employeeId]) {
      const d = await api.hourBank.forEmployee(employeeId)
      setDetails(s => ({ ...s, [employeeId]: d }))
    }
  }

  async function refreshEmployee(employeeId) {
    const d = await api.hourBank.forEmployee(employeeId)
    setDetails(s => ({ ...s, [employeeId]: d }))
    load() // update aggregated balance too
  }

  async function handleDelete(employeeId, entryId) {
    if (!(await confirm('Supprimer cet ajustement ?'))) return
    await api.hourBank.deleteEntry(entryId)
    refreshEmployee(employeeId)
  }

  async function handlePatch(employeeId, entryId, patch) {
    await api.hourBank.updateEntry(entryId, patch)
    refreshEmployee(employeeId)
  }

  async function handleAdd(employeeId, form) {
    await api.hourBank.create({ ...form, employee_id: employeeId })
    setAddFor(null)
    refreshEmployee(employeeId)
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Wallet size={20} className="text-slate-400" />
          <h1 className="text-2xl font-bold text-slate-900">Banque d'heures</h1>
          <span className="text-sm text-slate-400">— excédent / déficit par employé</span>
        </div>

        <div className="card overflow-hidden">
          {loading ? (
            <div className="p-6 text-sm text-slate-400">Chargement…</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-slate-400 italic">Aucun employé.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-slate-100">
                  <th className="px-4 py-2 w-8"></th>
                  <th className="px-4 py-2">Employé</th>
                  <th className="px-4 py-2 w-24">Matricule</th>
                  <th className="px-4 py-2 w-20 text-center">Ajust.</th>
                  <th className="px-4 py-2 w-32 text-right">Solde</th>
                  <th className="px-4 py-2 w-32">Dernier ajust.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isOpen = !!expanded[r.employee_id]
                  const d = details[r.employee_id]
                  return (
                    <>
                      <tr key={r.employee_id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => toggleExpand(r.employee_id)}>
                        <td className="px-4 py-2">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="px-4 py-2 font-medium text-slate-900">
                          {[r.first_name, r.last_name].filter(Boolean).join(' ') || '(sans nom)'}
                          {!r.active && <span className="ml-2 text-xs text-slate-400">(inactif)</span>}
                        </td>
                        <td className="px-4 py-2 text-slate-500 font-mono">{r.matricule || '—'}</td>
                        <td className="px-4 py-2 text-center text-slate-500">{r.entry_count}</td>
                        <td className={`px-4 py-2 text-right tabular-nums font-semibold ${r.balance_hours > 0 ? 'text-emerald-600' : r.balance_hours < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                          {fmtHours(r.balance_hours)}
                        </td>
                        <td className="px-4 py-2 text-slate-500">{r.last_entry_date ? fmtDate(r.last_entry_date) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-slate-50/40">
                          <td colSpan={6} className="px-4 py-3">
                            <EntryList
                              employeeId={r.employee_id}
                              details={d}
                              isAdding={addFor === r.employee_id}
                              onStartAdd={() => setAddFor(r.employee_id)}
                              onCancelAdd={() => setAddFor(null)}
                              onAdd={handleAdd}
                              onPatch={handlePatch}
                              onDelete={handleDelete}
                            />
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}

function EntryList({ employeeId, details, isAdding, onStartAdd, onCancelAdd, onAdd, onPatch, onDelete }) {
  if (!details) return <div className="text-sm text-slate-400">Chargement…</div>
  const { entries = [] } = details
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          Solde : <span className="font-semibold text-slate-900 tabular-nums">{fmtHours(details.balance_hours)}</span>
        </div>
        {!isAdding && (
          <button onClick={onStartAdd} className="text-xs text-brand-600 hover:underline flex items-center gap-1">
            <Plus size={12} /> Ajouter un ajustement manuel
          </button>
        )}
      </div>
      {isAdding && <AddForm employeeId={employeeId} onCancel={onCancelAdd} onAdd={onAdd} />}
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
                  <input type="date" className={inp + ' w-32'} defaultValue={e.date} onBlur={ev => ev.target.value !== e.date && onPatch(employeeId, e.id, { date: ev.target.value })} />
                </td>
                <td className="px-2 py-1">
                  <input type="number" step="0.25" className={inp + ' w-24 text-right'} defaultValue={e.hours} onBlur={ev => Number(ev.target.value) !== Number(e.hours) && onPatch(employeeId, e.id, { hours: Number(ev.target.value) })} />
                </td>
                <td className="px-2 py-1 text-xs">
                  {e.source === 'timesheet_import' ? <span className="text-brand-600">Feuilles de temps</span> : e.source === 'manual' ? <span className="text-slate-500">Manuel</span> : <span className="text-slate-400">{e.source || '—'}</span>}
                </td>
                <td className="px-2 py-1 text-xs text-slate-500">{e.paie_number ? `#${e.paie_number}` : '—'}</td>
                <td className="px-2 py-1">
                  <input className={inp} defaultValue={e.notes || ''} onBlur={ev => (ev.target.value || '') !== (e.notes || '') && onPatch(employeeId, e.id, { notes: ev.target.value || null })} />
                </td>
                <td className="px-1">
                  <button onClick={() => onDelete(employeeId, e.id)} className="p-1 text-slate-300 hover:text-red-500" title="Supprimer"><Trash2 size={13} /></button>
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
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
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
