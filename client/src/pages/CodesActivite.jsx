import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, Tag, X, Search } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'

const inp = 'w-full border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

export default function CodesActivite() {
  const [codes, setCodes] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newPayable, setNewPayable] = useState(true)
  const [adding, setAdding] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [users, setUsers] = useState([])
  const [usersByCode, setUsersByCode] = useState({})  // codeId → [{id, name}, ...]
  const confirm = useConfirm()
  const { addToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // `?all=1` : page admin de gestion → on veut voir tous les codes, sans filtre de visibilité.
      const params = { all: '1' }
      if (includeInactive) params.include_inactive = '1'
      const r = await api.activityCodes.list(params)
      const list = r.data || r
      setCodes(list)

      // Charge les assignations users en parallèle pour pouvoir afficher les chips dès l'arrivée.
      const entries = await Promise.all(
        list.map(c => api.activityCodes.getUsers(c.id).then(r => [c.id, r.data || []]).catch(() => [c.id, []]))
      )
      setUsersByCode(Object.fromEntries(entries))
    } finally { setLoading(false) }
  }, [includeInactive])

  useEffect(() => { load() }, [load])
  useEntityListRealtime('activity_code', setCodes)

  // Liste de tous les users (admin endpoint requis car on veut pouvoir assigner même des
  // comptes inactifs — utile p. ex. après l'import historique de feuilles de temps).
  useEffect(() => {
    api.admin.listUsers().then(setUsers).catch(() => setUsers([]))
  }, [])

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

  async function handleSetUsers(codeId, user_ids) {
    try {
      const r = await api.activityCodes.setUsers(codeId, user_ids)
      setUsersByCode(m => ({ ...m, [codeId]: r.data || [] }))
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
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
                  <th className="px-4 py-2 w-56">Nom</th>
                  <th className="px-4 py-2">Partagé avec</th>
                  <th className="px-4 py-2 w-20 text-center">Payable</th>
                  <th className="px-4 py-2 w-20 text-center">Actif</th>
                  <th className="px-4 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {codes.map(c => (
                  <CodeRow
                    key={c.id}
                    code={c}
                    users={users}
                    assignedUsers={usersByCode[c.id] || []}
                    onPatch={handlePatch}
                    onDelete={handleDelete}
                    onSetUsers={handleSetUsers}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}

function CodeRow({ code, users, assignedUsers, onPatch, onDelete, onSetUsers }) {
  const [name, setName] = useState(code.name)
  useEffect(() => { setName(code.name) }, [code.id, code.name])

  const commitName = () => {
    const v = name.trim()
    if (!v || v === code.name) { setName(code.name); return }
    onPatch(code.id, { name: v })
  }

  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-4 py-2">
        <input
          className={inp}
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </td>
      <td className="px-4 py-2">
        <UserChipsPicker
          codeId={code.id}
          users={users}
          assigned={assignedUsers}
          onChange={ids => onSetUsers(code.id, ids)}
        />
      </td>
      <td className="px-4 py-2 text-center">
        <input
          type="checkbox"
          checked={!!code.payable}
          onChange={e => onPatch(code.id, { payable: e.target.checked })}
          className="rounded mt-2"
          aria-label={code.payable ? 'Marquer comme non payable' : 'Marquer comme payable'}
          title="Les heures de ce code comptent-elles dans le total à payer ?"
        />
      </td>
      <td className="px-4 py-2 text-center">
        <input
          type="checkbox"
          checked={!!code.active}
          onChange={e => onPatch(code.id, { active: e.target.checked })}
          className="rounded mt-2"
          aria-label={code.active ? 'Désactiver' : 'Activer'}
        />
      </td>
      <td className="px-2 py-2 text-center">
        <button
          onClick={() => onDelete(code)}
          className="p-1 mt-1 text-slate-300 hover:text-red-500"
          title="Supprimer"
          aria-label="Supprimer"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  )
}

// Multi-picker : chips des users assignés + bouton "+ Ajouter" qui ouvre une popup de
// recherche pour ajouter un user. Une liste vide est affichée comme "Tous les employés"
// (rappel sémantique : 0 ligne ⇒ public, ≥1 ⇒ restreint à la liste).
function UserChipsPicker({ codeId, users, assigned, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const popupRef = useRef(null)
  const highlightRef = useRef(null)

  const assignedIds = assigned.map(u => u.id)
  const available = users.filter(u => !assignedIds.includes(u.id))
  const q = query.trim().toLowerCase()
  const filtered = (q ? available.filter(u => (u.name || '').toLowerCase().includes(q)) : available).slice(0, 100)

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) {
      const popupH = 280
      const spaceBelow = window.innerHeight - rect.bottom
      const openUp = spaceBelow < popupH && rect.top > popupH
      setPos({
        top: openUp ? rect.top - popupH - 4 : rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 240),
      })
    }
    const onDown = (e) => {
      if (!btnRef.current?.contains(e.target) && !popupRef.current?.contains(e.target)) {
        setOpen(false); setQuery('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    setHighlightIdx(i => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    if (open && highlightRef.current) highlightRef.current.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, open])

  const addUser = (id) => {
    onChange([...assignedIds, id])
    setQuery('')
    setHighlightIdx(0)
    // Garder la popup ouverte pour permettre des ajouts successifs
  }

  const removeUser = (id) => onChange(assignedIds.filter(x => x !== id))

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`code-users-${codeId}`}>
      {assigned.length === 0 && (
        <span className="text-xs italic text-slate-400" data-testid={`code-users-public-${codeId}`}>Tous les employés</span>
      )}
      {assigned.map(u => (
        <span key={u.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-md">
          {u.name}
          <button
            type="button"
            onClick={() => removeUser(u.id)}
            className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-slate-300/60"
            aria-label={`Retirer ${u.name}`}
            data-testid={`code-users-remove-${codeId}-${u.id}`}
          ><X size={12} /></button>
        </span>
      ))}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-xs px-2 py-0.5 border border-dashed border-slate-300 rounded-md text-slate-500 hover:bg-slate-50"
        data-testid={`code-users-add-${codeId}`}
      >+ Ajouter</button>
      {open && createPortal(
        <div
          ref={popupRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search size={12} className="text-slate-400" />
            <input
              autoFocus
              className="w-full text-sm focus:outline-none"
              placeholder="Rechercher un employé…"
              value={query}
              onChange={e => { setQuery(e.target.value); setHighlightIdx(0) }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(filtered.length - 1, i + 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(0, i - 1)) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (filtered[highlightIdx]) addUser(filtered[highlightIdx].id)
                } else if (e.key === 'Escape') {
                  e.preventDefault(); setOpen(false); setQuery('')
                }
              }}
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0
              ? <div className="px-3 py-2 text-xs text-slate-500">Aucun employé disponible</div>
              : filtered.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  ref={i === highlightIdx ? highlightRef : null}
                  onClick={() => addUser(u.id)}
                  onMouseEnter={() => setHighlightIdx(i)}
                  className={`w-full text-left px-3 py-1.5 text-sm truncate ${i === highlightIdx ? 'bg-slate-100' : ''} text-slate-700`}
                >{u.name}</button>
              ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
