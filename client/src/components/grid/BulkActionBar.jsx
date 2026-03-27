import { Trash2, X, Copy } from 'lucide-react'

export function BulkActionBar({ count, onDelete, onDuplicate, onClear }) {
  if (!count) return null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-900 text-white rounded-xl shadow-2xl px-4 py-2.5 text-sm">
      <span className="font-medium mr-2">{count} sélectionné{count > 1 ? 's' : ''}</span>

      {onDuplicate && (
        <button
          onClick={onDuplicate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors text-xs"
        >
          <Copy size={13} />
          Dupliquer
        </button>
      )}

      <button
        onClick={onDelete}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 transition-colors text-xs"
      >
        <Trash2 size={13} />
        Supprimer
      </button>

      <button
        onClick={onClear}
        className="p-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors ml-1"
        title="Désélectionner"
      >
        <X size={14} />
      </button>
    </div>
  )
}
