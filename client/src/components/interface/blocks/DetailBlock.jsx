import { useState, useEffect } from 'react'
import { CellRenderer } from '../../grid/CellRenderer.jsx'
import { baseAPI } from '../../../hooks/useBaseAPI.js'

const READ_ONLY = ['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at']

export default function DetailBlock({ config, selectedRecord, onRecordChange }) {
  const [fields, setFields] = useState([])
  const [localRecord, setLocalRecord] = useState(null)
  const [editingKey, setEditingKey] = useState(null)

  useEffect(() => {
    if (!config.table_id) return
    baseAPI.fields(config.table_id)
      .then(res => setFields((res.fields || []).filter(f => !f.deleted_at)))
      .catch(() => {})
  }, [config.table_id])

  useEffect(() => {
    setLocalRecord(selectedRecord ?? null)
    setEditingKey(null)
  }, [selectedRecord?.id])

  if (!selectedRecord) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 italic text-center p-4">
        Sélectionnez un enregistrement dans la liste
      </div>
    )
  }

  if (!localRecord) return <div className="text-sm text-gray-400 p-4">Chargement…</div>

  const visibleFields = config.fields
    ? fields.filter(f => config.fields.includes(f.key))
    : fields

  async function handleSave(fieldKey, newValue) {
    setEditingKey(null)
    const oldValue = localRecord.data?.[fieldKey]
    setLocalRecord(prev => ({ ...prev, data: { ...(prev.data || {}), [fieldKey]: newValue } }))
    try {
      await baseAPI.updateRecord(config.table_id, localRecord.id, { data: { [fieldKey]: newValue } })
      onRecordChange?.()
    } catch {
      setLocalRecord(prev => ({ ...prev, data: { ...(prev.data || {}), [fieldKey]: oldValue } }))
    }
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-2">
      {visibleFields.map(field => {
        const isReadOnly = !config.editable || READ_ONLY.includes(field.type)
        const isEditing = editingKey === field.key
        return (
          <div key={field.key} className="flex items-start gap-2">
            <label className="w-28 shrink-0 text-xs text-gray-500 pt-1.5 truncate">{field.name}</label>
            <div
              className={`flex-1 min-w-0 rounded px-2 py-1 min-h-[28px] flex items-center ${
                isEditing ? 'ring-1 ring-indigo-400 bg-slate-50' :
                isReadOnly ? 'bg-slate-50' : 'hover:bg-slate-50 cursor-pointer'
              }`}
              onClick={() => !isReadOnly && !isEditing && setEditingKey(field.key)}
            >
              <CellRenderer
                field={field}
                value={localRecord.data?.[field.key]}
                editing={isEditing}
                onCommit={val => handleSave(field.key, val)}
                onCancel={() => setEditingKey(null)}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
