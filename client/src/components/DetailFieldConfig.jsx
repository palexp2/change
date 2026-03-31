import { useState } from 'react'
import { Eye, EyeOff, GripVertical, Check, X, Settings } from 'lucide-react'

/**
 * Admin panel to reorder and show/hide fields on a detail page.
 * Appears as a slide-out panel on the right side.
 */
export function DetailFieldConfig({ configFields, onToggle, onMove, onSave, onCancel }) {
  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative w-80 bg-white shadow-xl border-l border-slate-200 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Settings size={15} className="text-slate-400" />
            <h3 className="text-sm font-semibold text-slate-900">Champs de la fiche</h3>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onCancel} className="p-1.5 text-slate-400 hover:text-slate-600 rounded transition-colors">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {configFields.map((field, idx) => (
            <div
              key={field.key}
              className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-lg transition-all ${
                draggingIdx === idx ? 'opacity-40' : ''
              } ${dragOverIdx === idx && dragOverIdx !== draggingIdx ? 'border-t-2 border-indigo-400' : ''
              } hover:bg-slate-50`}
              draggable
              onDragStart={() => setDraggingIdx(idx)}
              onDragOver={e => { e.preventDefault(); setDragOverIdx(idx) }}
              onDrop={e => {
                e.preventDefault()
                if (draggingIdx !== null && draggingIdx !== idx) onMove(draggingIdx, idx)
                setDraggingIdx(null)
                setDragOverIdx(null)
              }}
              onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null) }}
            >
              <GripVertical size={14} className="text-slate-300 cursor-grab flex-shrink-0" />
              <span className={`flex-1 text-sm ${field.visible ? 'text-slate-700' : 'text-slate-400'}`}>
                {field.label}
              </span>
              <button
                onClick={() => onToggle(field.key)}
                className={`p-1 rounded transition-colors ${
                  field.visible
                    ? 'text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50'
                    : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'
                }`}
                title={field.visible ? 'Masquer' : 'Afficher'}
              >
                {field.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-200 px-4 py-3 flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary text-sm">Annuler</button>
          <button onClick={onSave} className="btn-primary text-sm">
            <Check size={14} /> Enregistrer
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small button to trigger the config panel (for admin users) */
export function DetailConfigButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
      title="Configurer les champs"
    >
      <Settings size={15} />
    </button>
  )
}
