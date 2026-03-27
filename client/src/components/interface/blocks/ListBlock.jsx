import { useState, useEffect } from 'react'
import { useBlockData } from '../../../hooks/useBlockData.js'
import { CellRenderer } from '../../grid/CellRenderer.jsx'
import { baseAPI } from '../../../hooks/useBaseAPI.js'

export default function ListBlock({ block, config, filterValues, selectedRecordId, onRecordSelect }) {
  const { data, loading } = useBlockData(block.id, filterValues)
  const [fields, setFields] = useState([])

  useEffect(() => {
    if (!config.table_id) return
    baseAPI.fields(config.table_id)
      .then(res => setFields((res.fields || []).filter(f => !f.deleted_at)))
      .catch(() => {})
  }, [config.table_id])

  const visibleFields = config.fields
    ? fields.filter(f => config.fields.includes(f.key))
    : fields.slice(0, 4)

  if (!config.table_id) {
    return <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">Configurer une table</div>
  }
  if (loading) return <div className="text-sm text-gray-400 p-2">Chargement…</div>

  const records = data?.data || []

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              {visibleFields.map(f => (
                <th key={f.key} className="text-left px-3 py-2 text-xs font-medium text-gray-500 whitespace-nowrap border-b">
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {records.map(record => (
              <tr
                key={record.id}
                onClick={() => onRecordSelect?.(record)}
                className={`cursor-pointer hover:bg-gray-50 transition-colors ${
                  selectedRecordId === record.id ? 'bg-indigo-50' : ''
                }`}
              >
                {visibleFields.map(f => (
                  <td key={f.key} className="px-3 py-1.5 text-gray-700 whitespace-nowrap truncate max-w-[180px]">
                    <CellRenderer field={f} value={record.data?.[f.key]} editing={false} onCommit={() => {}} onCancel={() => {}} />
                  </td>
                ))}
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={visibleFields.length || 1} className="px-3 py-8 text-center text-gray-400 text-xs">
                  Aucun enregistrement
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data?.total > (config.limit || 50) && (
        <div className="px-3 py-1.5 text-xs text-gray-400 border-t bg-gray-50 shrink-0">
          {records.length} sur {data.total}
        </div>
      )}
    </div>
  )
}
