import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Tag } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-indigo-400 bg-white'

export default function CodesActivite() {
  const [codes, setCodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newPayable, setNewPayable] = useState(true)
  const [adding, setAdding] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.activityCodes.list(includeInactive ? { include_inactive: '1' } : {})
      setCodes(r.data || r)
    } finally { setLoading(false) }
  }, [includeInactive])

  useEffect(() => { load() }, [load])

  async function handleAdd(e) {
    e.preventDefault()
    if (!newName.trim()) return
    setAdding(true)
    try {
      await api.activityCodes.create({
        name: newName.trim(),
        payable: newPayable,
      })
      setNewName(''); setNewPayable(true)
      load()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setAdding(false)
    }
  }

  async function handlePatch(id, patch) {
    try {
      const updated = await api.activityCodes.update(id, patch)
      setCodes(cs => cs.map(c => c.id === id ? updated : c))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      load()
    }
  }

  async function handleDelete(code) {
    if (!(await confirm(`Supprimer le code "${code.name}" ?`))) return
    try {
      await api.activityCodes.delete(code.id)
      load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Tag size={20} className="text-slate-400" />
          <h1 className="text-2xl font-bold text-slate-900">Codes d'activité</h1>
          <span className="text-sm text-slate-400">— utilisés dans les feuilles de temps</span>
        </div>

        <div className="card p-5 mb-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Ajouter un code</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-6 gap-3">
            <div className="col-span-3">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 block">Nom *</label>
              <input className={inp} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex. Formation, Administration…" required />
            </div>
            <div className="col-span-2 flex flex-col">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1 block">Payable</label>
              <label className="flex items-center gap-2 text-sm text-slate-700 h-[30px] cursor-pointer">
                <input type="checkbox" checked={newPayable} onChange={e => setNewPayable(e.target.checked)} className="rounded" />
                Heures rémunérées
              </label>
            </div>
            <div className="col-span-1 flex items-end">
              <button type="submit" disabled={adding || !newName.trim()} className="btn-primary w-full flex items-center justify-center gap-1.5">
                <Plus size={14} /> Ajouter
              </button>
            </div>
          </form>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">
              {codes.length} code{codes.length !== 1 ? 's' : ''}
            </h2>
            <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer">
              <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} className="rounded" />
              Afficher les inactifs
            </label>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-slate-400">Chargement…</div>
          ) : codes.length === 0 ? (
            <div className="p-6 text-sm text-slate-400 italic">Aucun code d'activité. Ajoutez-en un ci-dessus.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400">
                  <th className="px-4 py-2">Nom</th>
                  <th className="px-4 py-2 w-24 text-center">Payable</th>
                  <th className="px-4 py-2 w-24 text-center">Actif</th>
                  <th className="px-4 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {codes.map(c => (
                  <CodeRow key={c.id} code={c} onPatch={handlePatch} onDelete={handleDelete} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}

function CodeRow({ code, onPatch, onDelete }) {
  const [name, setName] = useState(code.name)
  useEffect(() => { setName(code.name) }, [code.id, code.name])

  const commitName = () => {
    const v = name.trim()
    if (!v || v === code.name) { setName(code.name); return }
    onPatch(code.id, { name: v })
  }

  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-2">
        <input
          className={inp}
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </td>
      <td className="px-4 py-2 text-center">
        <input
          type="checkbox"
          checked={!!code.payable}
          onChange={e => onPatch(code.id, { payable: e.target.checked })}
          className="rounded"
          aria-label={code.payable ? 'Marquer comme non payable' : 'Marquer comme payable'}
          title="Les heures de ce code comptent-elles dans le total à payer ?"
        />
      </td>
      <td className="px-4 py-2 text-center">
        <input
          type="checkbox"
          checked={!!code.active}
          onChange={e => onPatch(code.id, { active: e.target.checked })}
          className="rounded"
          aria-label={code.active ? 'Désactiver' : 'Activer'}
        />
      </td>
      <td className="px-2 py-2 text-center">
        <button
          onClick={() => onDelete(code)}
          className="p-1 text-slate-300 hover:text-red-500"
          title="Supprimer"
          aria-label="Supprimer"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  )
}
