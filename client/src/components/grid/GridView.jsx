import { useState, useCallback, useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ColumnHeader } from './ColumnHeader.jsx'
import { GridRow } from './GridRow.jsx'
import { BulkActionBar } from './BulkActionBar.jsx'
import { Plus, Loader2 } from 'lucide-react'

const ROW_HEIGHT = 36
const CHECKBOX_COL = 52
const DEFAULT_COL_WIDTH = 180
const ADD_COL_WIDTH = 120

export function GridView({
  fields = [],
  records = [],
  loading = false,
  sorts = [],
  onSortChange,
  onCellSave,
  onAddRecord,
  onAddField,
  onBulkDelete,
  onExpandRecord,
  onFieldResize,
  onFieldMenuOpen,
}) {
  const [columnWidths, setColumnWidths] = useState({})
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [activeCell, setActiveCell] = useState(null) // { recordId, fieldId, editing }

  const parentRef = useRef()

  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // Reset selection when records change
  useEffect(() => {
    setSelectedIds(prev => {
      const ids = new Set(records.map(r => r.id))
      const next = new Set([...prev].filter(id => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [records])

  function getColWidth(fieldId) {
    return columnWidths[fieldId] || DEFAULT_COL_WIDTH
  }

  function handleResize(fieldId, width) {
    setColumnWidths(prev => ({ ...prev, [fieldId]: width }))
    onFieldResize?.(fieldId, width)
  }

  function getSortFor(fieldId) {
    const s = sorts.find(s => s.field_id === fieldId)
    return s?.direction || null
  }

  function handleSort(fieldId, direction) {
    if (!onSortChange) return
    const filtered = sorts.filter(s => s.field_id !== fieldId)
    if (direction) onSortChange([...filtered, { field_id: fieldId, direction }])
    else onSortChange(filtered)
  }

  function handleSelectAll(checked) {
    setSelectedIds(checked ? new Set(records.map(r => r.id)) : new Set())
  }

  function handleSelectRow(id, checked) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }

  function handleCellClick(recordId, fieldId) {
    if (activeCell?.recordId === recordId && activeCell?.fieldId === fieldId) return
    setActiveCell({ recordId, fieldId, editing: false })
  }

  function handleCellDoubleClick(recordId, fieldId) {
    const field = fields.find(f => f.id === fieldId)
    const readonly = ['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber'].includes(field?.type)
    if (readonly) return
    setActiveCell({ recordId, fieldId, editing: true })
  }

  async function handleCellCommit(recordId, fieldId, fieldKey, newValue) {
    setActiveCell(prev => prev?.editing ? { ...prev, editing: false } : prev)
    await onCellSave?.(recordId, { [fieldKey]: newValue })
  }

  function handleCellCancel() {
    setActiveCell(prev => prev ? { ...prev, editing: false } : null)
  }

  // Keyboard nav
  useEffect(() => {
    function onKey(e) {
      if (!activeCell) return

      if (activeCell.editing) {
        if (e.key === 'Tab') {
          e.preventDefault()
          const idx = fields.findIndex(f => f.id === activeCell.fieldId)
          const next = fields[e.shiftKey ? idx - 1 : idx + 1]
          if (next) setActiveCell({ recordId: activeCell.recordId, fieldId: next.id, editing: false })
        }
        return
      }

      const rIdx = records.findIndex(r => r.id === activeCell.recordId)
      const fIdx = fields.findIndex(f => f.id === activeCell.fieldId)

      if (e.key === 'ArrowDown' && rIdx < records.length - 1) {
        e.preventDefault()
        setActiveCell({ recordId: records[rIdx + 1].id, fieldId: activeCell.fieldId, editing: false })
      } else if (e.key === 'ArrowUp' && rIdx > 0) {
        e.preventDefault()
        setActiveCell({ recordId: records[rIdx - 1].id, fieldId: activeCell.fieldId, editing: false })
      } else if (e.key === 'ArrowRight' && fIdx < fields.length - 1) {
        e.preventDefault()
        setActiveCell({ recordId: activeCell.recordId, fieldId: fields[fIdx + 1].id, editing: false })
      } else if (e.key === 'ArrowLeft' && fIdx > 0) {
        e.preventDefault()
        setActiveCell({ recordId: activeCell.recordId, fieldId: fields[fIdx - 1].id, editing: false })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const next = fields[e.shiftKey ? fIdx - 1 : fIdx + 1]
        if (next) setActiveCell({ recordId: activeCell.recordId, fieldId: next.id, editing: false })
      } else if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault()
        setActiveCell(prev => ({ ...prev, editing: true }))
      } else if (e.key === 'Escape') {
        setActiveCell(null)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const field = fields.find(f => f.id === activeCell.fieldId)
        const readonly = ['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber'].includes(field?.type)
        if (!readonly) {
          handleCellCommit(activeCell.recordId, activeCell.fieldId, field.key, null)
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        setActiveCell(prev => ({ ...prev, editing: true }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeCell, fields, records])

  const totalWidth = CHECKBOX_COL + fields.reduce((s, f) => s + getColWidth(f.id), 0) + ADD_COL_WIDTH

  const allSelected = records.length > 0 && selectedIds.size === records.length
  const indeterminate = selectedIds.size > 0 && !allSelected

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-stretch h-9 border-b border-slate-200 bg-slate-50 overflow-x-auto" style={{ minWidth: totalWidth }}>
        {/* Select-all */}
        <div className="flex items-center justify-center flex-shrink-0 border-r border-slate-200" style={{ width: CHECKBOX_COL }}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = indeterminate }}
            onChange={e => handleSelectAll(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 cursor-pointer"
          />
        </div>

        {fields.map(field => (
          <ColumnHeader
            key={field.id}
            field={field}
            width={getColWidth(field.id)}
            sort={getSortFor(field.id)}
            onSort={(dir) => handleSort(field.id, dir)}
            onResize={(w) => handleResize(field.id, w)}
            onMenuOpen={onFieldMenuOpen}
          />
        ))}

        {/* Add field button */}
        <button
          className="flex items-center gap-1 px-3 text-xs text-slate-400 hover:text-slate-700 hover:bg-slate-100 border-r border-slate-200 flex-shrink-0 transition-colors"
          style={{ width: ADD_COL_WIDTH }}
          onClick={onAddField}
        >
          <Plus size={13} />
          Ajouter un champ
        </button>
      </div>

      {/* Rows */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
        style={{ minWidth: totalWidth }}
      >
        {loading && !records.length ? (
          <div className="flex items-center justify-center h-32 text-slate-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            Chargement…
          </div>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map(vRow => {
              const record = records[vRow.index]
              return (
                <div
                  key={record.id}
                  style={{ position: 'absolute', top: vRow.start, left: 0, width: '100%' }}
                >
                  <GridRow
                    record={record}
                    fields={fields}
                    columnWidths={Object.fromEntries(fields.map(f => [f.id, getColWidth(f.id)]))}
                    selected={selectedIds.has(record.id)}
                    activeCell={activeCell}
                    onSelect={handleSelectRow}
                    onCellClick={handleCellClick}
                    onCellDoubleClick={handleCellDoubleClick}
                    onCellCommit={handleCellCommit}
                    onCellCancel={handleCellCancel}
                    onExpandRecord={onExpandRecord}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Add record row */}
        {!loading && (
          <button
            className="flex items-center gap-2 px-4 py-2 text-sm text-slate-400 hover:text-slate-700 hover:bg-slate-50 w-full border-b border-slate-100 transition-colors"
            onClick={onAddRecord}
          >
            <Plus size={14} />
            Ajouter un enregistrement
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedIds.size}
        onDelete={() => { onBulkDelete?.([...selectedIds]); setSelectedIds(new Set()) }}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  )
}
