import { useState } from 'react'
import { X, Loader2, AlertCircle } from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'
import { DynamicIcon } from '../ui/DynamicIcon.jsx'

const COLORS = [
  'slate', 'red', 'orange', 'amber', 'yellow',
  'green', 'teal', 'blue', 'indigo', 'violet', 'purple', 'pink',
]

const ICONS = [
  'Table', 'Database', 'Package', 'Users', 'User', 'Building2',
  'ShoppingCart', 'FileText', 'BarChart2', 'Layers', 'Tag', 'Folder',
  'Star', 'Heart', 'Briefcase', 'Globe', 'Mail', 'Phone',
  'Calendar', 'Clock', 'Settings', 'Wrench', 'Box', 'Truck',
]

export function TableSettingsModal({ table, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(table.name || '')
  const [icon, setIcon] = useState(table.icon || 'Table')
  const [color, setColor] = useState(table.color || 'indigo')
  const [description, setDescription] = useState(table.description || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!name.trim()) { setError('Le nom est requis'); return }
    setSaving(true)
    setError('')
    try {
      const res = await baseAPI.updateTable(table.id, {
        name: name.trim(),
        icon,
        color,
        description: description.trim() || null,
      })
      onSaved?.(res.table || { ...table, name: name.trim(), icon, color, description })
      onClose()
    } catch (e) {
      setError(e.message || 'Erreur lors de la sauvegarde')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Supprimer "${table.name}" ?\nLa table et tous ses enregistrements seront déplacés dans la corbeille pendant 30 jours.`)) return
    setSaving(true)
    try {
      await baseAPI.deleteTable(table.id)
      onDeleted?.()
      onClose()
    } catch (e) {
      setError(e.message || 'Erreur lors de la suppression')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-[480px] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h3 className="font-semibold text-slate-900">Paramètres de la table</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nom</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none"
            />
          </div>

          {/* Icon */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Icône</label>
            <div className="flex flex-wrap gap-1.5">
              {ICONS.map(ic => (
                <button
                  key={ic}
                  type="button"
                  onClick={() => setIcon(ic)}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${
                    icon === ic
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-600'
                      : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                  title={ic}
                >
                  <DynamicIcon name={ic} size={14} />
                </button>
              ))}
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Couleur</label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full bg-${c}-500 transition-transform ${
                    color === c ? 'scale-125 ring-2 ring-offset-2 ring-${c}-500' : 'hover:scale-110'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Description <span className="font-normal text-slate-400">(optionnel)</span>
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              placeholder="Description de cette table…"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none resize-none"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 px-3 py-2 rounded-lg text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
          <button
            onClick={handleDelete}
            disabled={saving}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Supprimer la table
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

