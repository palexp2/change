import { useState, useEffect, useCallback } from 'react'
import { Modal } from '../Modal.jsx'
import { Search, Loader2, Check } from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'

export function LinkPickerModal({ open, onClose, targetTableId, selectedIds = [], onConfirm, multi = true }) {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState(new Set(selectedIds))

  useEffect(() => {
    if (!open) return
    setSelected(new Set(selectedIds))
  }, [open, selectedIds.join(',')])

  const load = useCallback(async () => {
    if (!targetTableId) return
    setLoading(true)
    try {
      const params = { limit: 50 }
      if (q) params.search = q
      const res = await baseAPI.records(targetTableId, params)
      setRecords(res.data || [])
    } catch {
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [targetTableId, q])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [open, load])

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      if (!multi) return new Set(next.has(id) ? [] : [id])
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function getPrimaryValue(record) {
    const data = record.data || {}
    const vals = Object.values(data).filter(v => v !== null && v !== undefined && v !== '')
    return vals[0] != null ? String(vals[0]) : record.id
  }

  return (
    <Modal isOpen={open} onClose={onClose} title="Choisir un enregistrement" size="md">
      <div className="space-y-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Rechercher…"
            className="input pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
          {loading ? (
            <div className="flex items-center justify-center h-20 text-slate-400">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : records.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">Aucun résultat</div>
          ) : records.map(rec => {
            const isSelected = selected.has(rec.id)
            return (
              <button
                key={rec.id}
                type="button"
                onClick={() => toggle(rec.id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors text-sm ${isSelected ? 'bg-indigo-50' : ''}`}
              >
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'}`}>
                  {isSelected && <Check size={11} className="text-white" />}
                </div>
                <span className="truncate">{getPrimaryValue(rec)}</span>
                <span className="ml-auto text-xs text-slate-400 font-mono">{rec.id.slice(-6)}</span>
              </button>
            )
          })}
        </div>

        <div className="flex justify-between items-center pt-1">
          <span className="text-xs text-slate-500">{selected.size} sélectionné{selected.size > 1 ? 's' : ''}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Annuler</button>
            <button
              onClick={() => { onConfirm([...selected]); onClose() }}
              className="btn-primary"
            >
              Confirmer
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
