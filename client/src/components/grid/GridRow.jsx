import { memo } from 'react'
import { CellRenderer } from './CellRenderer.jsx'
import { Expand } from 'lucide-react'

const ROW_HEIGHT = 36

export const GridRow = memo(function GridRow({
  record,
  fields,
  columnWidths,
  selected,
  activeCell, // { recordId, fieldId }
  onSelect,
  onCellClick,
  onCellDoubleClick,
  onCellCommit,
  onCellCancel,
  onExpandRecord,
  style,
}) {
  const isSelected = selected

  return (
    <div
      className={`flex items-stretch border-b border-slate-100 group ${isSelected ? 'bg-indigo-50' : 'bg-white hover:bg-slate-50'}`}
      style={{ ...style, height: ROW_HEIGHT }}
    >
      {/* Checkbox + expand */}
      <div className="flex items-center flex-shrink-0 w-[52px] border-r border-slate-200 px-2 gap-1">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={e => onSelect(record.id, e.target.checked)}
          onClick={e => e.stopPropagation()}
          className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 cursor-pointer"
        />
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-opacity"
          onClick={e => { e.stopPropagation(); onExpandRecord?.(record) }}
          title="Ouvrir"
        >
          <Expand size={11} />
        </button>
      </div>

      {/* Cells */}
      {fields.map(field => {
        const width = columnWidths[field.id] || 180
        const value = record.data?.[field.key] ?? null
        const isActive = activeCell?.recordId === record.id && activeCell?.fieldId === field.id
        const isEditing = isActive && activeCell?.editing

        return (
          <div
            key={field.id}
            className={`relative flex items-center flex-shrink-0 border-r border-slate-100 px-2 overflow-hidden cursor-cell
              ${isActive ? 'ring-2 ring-inset ring-indigo-500 bg-white' : ''}
            `}
            style={{ width, height: ROW_HEIGHT }}
            onClick={() => onCellClick(record.id, field.id)}
            onDoubleClick={() => onCellDoubleClick(record.id, field.id)}
          >
            <CellRenderer
              field={field}
              value={value}
              editing={isEditing}
              onCommit={(newVal) => onCellCommit(record.id, field.id, field.key, newVal)}
              onCancel={onCellCancel}
            />
          </div>
        )
      })}

      {/* Trailing spacer */}
      <div className="flex-1 min-w-0" />
    </div>
  )
})
