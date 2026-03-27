import { useState, useEffect } from 'react'
import { Plus, Trash2, Pencil, GripVertical } from 'lucide-react'
import { baseAPI } from '../hooks/useBaseAPI.js'
import { FieldConfigPanel } from '../components/grid/FieldConfigPanel.jsx'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'

// ── Field type icons ──────────────────────────────────────────────────────────

const FIELD_TYPE_LABELS = {
  text: 'Texte',
  long_text: 'Texte long',
  number: 'Nombre',
  currency: 'Devise',
  percent: 'Pourcentage',
  date: 'Date',
  datetime: 'Date et heure',
  select: 'Sélection unique',
  multi_select: 'Sélection multiple',
  boolean: 'Case à cocher',
  link: 'Lien',
  user: 'Utilisateur',
  phone: 'Téléphone',
  email: 'Email',
  url: 'URL',
  formula: 'Formule',
  rollup: 'Rollup',
  lookup: 'Lookup',
  autonumber: 'Auto-numéro',
  attachment: 'Fichier',
  created_at: 'Date création',
  updated_at: 'Date modification',
}

const FIELD_TYPE_ICONS = {
  text: 'Type',
  long_text: 'AlignLeft',
  number: 'Hash',
  currency: 'DollarSign',
  percent: 'Percent',
  date: 'Calendar',
  datetime: 'Clock',
  select: 'ChevronDown',
  multi_select: 'List',
  boolean: 'ToggleLeft',
  link: 'Link2',
  user: 'User',
  phone: 'Phone',
  email: 'Mail',
  url: 'Globe',
  formula: 'Calculator',
  rollup: 'Calculator',
  lookup: 'Search',
  autonumber: 'Hash',
  attachment: 'Paperclip',
  created_at: 'Clock',
  updated_at: 'Clock',
}

// ── FieldListItem ─────────────────────────────────────────────────────────────

function FieldListItem({
  field,
  isDraggable,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver,
}) {
  return (
    <div
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragOver={e => { e.preventDefault(); onDragOver?.() }}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`flex items-center gap-3 px-4 py-3 hover:bg-slate-50 group transition-colors ${
        isDragOver ? 'border-t-2 border-indigo-400' : ''
      }`}
    >
      {isDraggable
        ? <GripVertical size={14} className="text-slate-300 cursor-grab shrink-0" />
        : <span className="w-3.5 shrink-0" />
      }

      <DynamicIcon
        name={FIELD_TYPE_ICONS[field.type] || 'Type'}
        size={15}
        className="text-slate-400 shrink-0"
      />

      <span className="text-sm font-medium text-slate-800 flex-1 truncate">{field.name}</span>

      {field.is_primary && (
        <span className="text-[10px] px-1.5 py-0.5 bg-indigo-100 text-indigo-600 rounded font-medium shrink-0">
          Primaire
        </span>
      )}
      {field.required && !field.is_primary && (
        <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded font-medium shrink-0">
          Requis
        </span>
      )}

      <span className="text-xs text-slate-400 shrink-0">
        {FIELD_TYPE_LABELS[field.type] || field.type}
      </span>

      <div className="opacity-0 group-hover:opacity-100 flex gap-1 shrink-0 transition-opacity">
        <button
          onClick={onEdit}
          className="p-1 text-slate-400 hover:text-slate-600 rounded"
          title="Modifier"
        >
          <Pencil size={13} />
        </button>
        {!field.is_primary && (
          <button
            onClick={onDelete}
            className="p-1 text-slate-400 hover:text-red-600 rounded"
            title="Supprimer"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── TableFieldsPage ───────────────────────────────────────────────────────────

export default function TableFieldsPage({ tableId }) {
  const [fields, setFields] = useState([])
  const [editingField, setEditingField] = useState(null)
  const [showFieldConfig, setShowFieldConfig] = useState(false)
  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  async function loadFields() {
    const res = await baseAPI.fields(tableId)
    setFields(res.fields || [])
  }

  useEffect(() => { loadFields() }, [tableId])

  async function handleDeleteField(field) {
    const message = field.type === 'link'
      ? `Supprimer "${field.name}" et son champ miroir ?\nLes données resteront en base mais ne seront plus visibles.`
      : `Supprimer "${field.name}" ?\nLes données resteront en base mais ne seront plus visibles.`
    if (!confirm(message)) return
    await baseAPI.deleteField(tableId, field.id)
    loadFields()
  }

  async function handleRestoreField(fieldId) {
    await baseAPI.restoreField(fieldId)
    loadFields()
  }

  async function handleReorder(fromIdx, toIdx) {
    if (fromIdx === toIdx) return
    const sortedActive = fields
      .filter(f => !f.deleted_at)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

    const reordered = [...sortedActive]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)

    // Optimistic update
    const newOrder = reordered.map((f, i) => ({ id: f.id, sort_order: i }))
    setFields(prev => {
      const deletedFields = prev.filter(f => f.deleted_at)
      return [
        ...reordered.map((f, i) => ({ ...f, sort_order: i })),
        ...deletedFields
      ]
    })

    try {
      await baseAPI.reorderFields(tableId, newOrder)
    } catch {
      loadFields() // Revert on error
    }
  }

  const activeFields = fields
    .filter(f => !f.deleted_at)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

  const deletedFields = fields.filter(f => f.deleted_at)

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Champs</h2>
        <button
          onClick={() => { setEditingField(null); setShowFieldConfig(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus size={14} /> Ajouter un champ
        </button>
      </div>

      {/* Active fields list */}
      <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {activeFields.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-400 text-center">Aucun champ</p>
        ) : (
          activeFields.map((field, idx) => (
            <FieldListItem
              key={field.id}
              field={field}
              isDraggable={!field.is_primary}
              isDragOver={dragOverIdx === idx}
              onEdit={() => { setEditingField(field); setShowFieldConfig(true) }}
              onDelete={() => handleDeleteField(field)}
              onDragStart={() => setDraggingIdx(idx)}
              onDragOver={() => setDragOverIdx(idx)}
              onDrop={() => {
                if (draggingIdx !== null && draggingIdx !== idx) {
                  handleReorder(draggingIdx, idx)
                }
                setDraggingIdx(null)
                setDragOverIdx(null)
              }}
              onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null) }}
            />
          ))
        )}
      </div>

      {/* Deleted fields (trash) */}
      {deletedFields.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-medium text-slate-500 mb-3 flex items-center gap-2">
            <Trash2 size={14} /> Corbeille des champs ({deletedFields.length})
          </h3>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden opacity-70">
            {deletedFields.map(field => (
              <div key={field.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-3.5" />
                <DynamicIcon
                  name={FIELD_TYPE_ICONS[field.type] || 'Type'}
                  size={15}
                  className="text-slate-300 shrink-0"
                />
                <span className="text-sm text-slate-400 line-through flex-1 truncate">{field.name}</span>
                <span className="text-xs text-slate-400 shrink-0">
                  Supprimé le {new Date(field.deleted_at).toLocaleDateString('fr-CA')}
                </span>
                <button
                  onClick={() => handleRestoreField(field.id)}
                  className="text-xs text-indigo-600 hover:text-indigo-700 shrink-0"
                >
                  Restaurer
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FieldConfigPanel */}
      {showFieldConfig && (
        <FieldConfigPanel
          tableId={tableId}
          field={editingField}
          allFields={activeFields}
          onClose={() => setShowFieldConfig(false)}
          onSaved={loadFields}
        />
      )}
    </div>
  )
}
