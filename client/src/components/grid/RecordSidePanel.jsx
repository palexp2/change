import { useState, useEffect } from 'react'
import { X, Copy, Trash2, Link } from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'
import { CellRenderer } from './CellRenderer.jsx'
import { useUndoRedo } from '../../hooks/useUndoRedo.jsx'

const READ_ONLY_TYPES = ['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber']

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeTime(dateString) {
  if (!dateString) return ''
  const d = new Date(dateString)
  if (isNaN(d)) return dateString
  const diff = (Date.now() - d) / 1000
  if (diff < 60) return "à l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)}j`
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatHistoryValue(v) {
  if (v == null) return 'vide'
  let val = v
  try { val = typeof v === 'string' ? JSON.parse(v) : v } catch {}
  if (val == null) return 'vide'
  if (typeof val === 'boolean') return val ? 'Oui' : 'Non'
  if (Array.isArray(val)) return val.join(', ')
  const s = String(val)
  return s.length > 50 ? s.slice(0, 50) + '…' : s
}

// ── FieldRow ──────────────────────────────────────────────────────────────────

function FieldRow({ field, value, isEditing, onEdit, onSave, onCancel }) {
  const isReadOnly = READ_ONLY_TYPES.includes(field.type)
  return (
    <div className="flex items-start gap-3 group">
      <label
        className="w-32 shrink-0 text-sm text-slate-500 pt-1.5 truncate"
        title={field.name}
      >
        {field.name}
      </label>
      <div
        className={`flex-1 min-w-0 rounded px-2 py-1 relative min-h-[30px] flex items-center ${
          isEditing
            ? 'bg-slate-50 ring-1 ring-indigo-400'
            : isReadOnly
            ? 'bg-slate-50'
            : 'hover:bg-slate-50 cursor-pointer'
        }`}
        onClick={() => !isReadOnly && !isEditing && onEdit()}
      >
        <CellRenderer
          field={field}
          value={value}
          editing={isEditing}
          onCommit={onSave}
          onCancel={onCancel}
        />
        {!isEditing && !isReadOnly && value == null && (
          <span className="text-xs text-slate-300 italic">Vide</span>
        )}
      </div>
    </div>
  )
}

// ── LinkedRecordsSection ──────────────────────────────────────────────────────

function LinkedRecordsSection({ field, value }) {
  const ids = Array.isArray(value) ? value : (value ? [value] : [])
  return (
    <div className="mb-3">
      <p className="text-sm font-medium text-slate-600 mb-1.5">{field.name}</p>
      {ids.length === 0 ? (
        <p className="text-xs text-slate-400 italic px-2">Aucun lien</p>
      ) : (
        <div className="space-y-1">
          {ids.map(id => (
            <div
              key={id}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-lg border border-slate-100"
            >
              <Link size={12} className="text-slate-400 shrink-0" />
              <span className="text-xs text-slate-600 truncate font-mono">{id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── HistoryTab ────────────────────────────────────────────────────────────────

function HistoryTab({ history }) {
  if (!history.length) {
    return <p className="p-6 text-sm text-slate-400 text-center">Aucun historique disponible</p>
  }
  return (
    <div className="p-5">
      <div className="relative">
        <div className="absolute left-3 top-0 bottom-0 w-px bg-slate-200" />
        {history.map(entry => (
          <div key={entry.id} className="relative pl-8 pb-5">
            <div className={`absolute left-1.5 w-3 h-3 rounded-full border-2 border-white ${
              entry.action === 'created' ? 'bg-emerald-400' :
              entry.action === 'deleted' ? 'bg-red-400' :
              'bg-indigo-400'
            }`} />
            <div className="text-sm text-slate-700">
              <span className="font-medium">{entry.user?.name || 'Système'}</span>
              {entry.action === 'created' && (
                <span className="text-slate-500"> a créé cet enregistrement</span>
              )}
              {entry.action === 'updated' && (
                <span className="text-slate-500">
                  {' '}a modifié{' '}
                  <span className={entry.field_deleted ? 'italic text-slate-400' : 'font-medium text-slate-700'}>
                    {entry.field_name || entry.field_key}
                  </span>
                  {entry.old_value != null && (
                    <>
                      {' : '}
                      <span className="text-slate-400 line-through">{formatHistoryValue(entry.old_value)}</span>
                      {' → '}
                      <span className="text-slate-700">{formatHistoryValue(entry.new_value)}</span>
                    </>
                  )}
                </span>
              )}
              {entry.action === 'deleted' && (
                <span className="text-slate-500"> a supprimé cet enregistrement</span>
              )}
              {entry.action === 'restored' && (
                <span className="text-slate-500"> a restauré cet enregistrement</span>
              )}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              {formatRelativeTime(entry.changed_at)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── RecordSidePanel (export) ──────────────────────────────────────────────────

export function RecordSidePanel({
  recordId,
  tableId,
  initialRecord,
  initialFields,
  onClose,
  onRecordChange,
}) {
  const [record, setRecord] = useState(initialRecord || null)
  const [fields, setFields] = useState(initialFields || [])
  const [activeTab, setActiveTab] = useState('details')
  const [editingFieldKey, setEditingFieldKey] = useState(null)
  const [history, setHistory] = useState([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const { pushFromAPIResponse } = useUndoRedo()

  // Load fields if not provided
  useEffect(() => {
    if (!initialFields || initialFields.length === 0) {
      baseAPI.fields(tableId).then(res => setFields(res.fields || []))
    }
  }, [tableId])

  // Sync record from parent
  useEffect(() => {
    if (initialRecord) setRecord(initialRecord)
  }, [initialRecord])

  // Reset history when record changes
  useEffect(() => {
    setHistoryLoaded(false)
    setHistory([])
    setActiveTab('details')
    setEditingFieldKey(null)
  }, [recordId])

  // Sync fields from parent when they update
  useEffect(() => {
    if (initialFields && initialFields.length > 0) setFields(initialFields)
  }, [initialFields])

  async function handleSaveField(fieldKey, newValue) {
    setEditingFieldKey(null)
    const oldValue = record.data[fieldKey]
    setRecord(prev => ({ ...prev, data: { ...prev.data, [fieldKey]: newValue } }))
    try {
      const res = await baseAPI.updateRecord(tableId, recordId, { data: { [fieldKey]: newValue } })
      onRecordChange?.()
      if (res?.undo) {
        pushFromAPIResponse(
          res,
          { method: 'PATCH', url: `/erp/api/base/records/${recordId}`, body: { data: { [fieldKey]: newValue } } },
          `modification de ${fieldKey}`
        )
      }
    } catch {
      setRecord(prev => ({ ...prev, data: { ...prev.data, [fieldKey]: oldValue } }))
    }
  }

  async function handleDuplicate() {
    try {
      const res = await baseAPI.duplicateRecord(tableId, recordId)
      onRecordChange?.()
      // Close current and let parent handle opening the new one
      onClose()
    } catch (e) {
      alert(e.message || 'Erreur lors de la duplication')
    }
  }

  async function handleDelete() {
    if (!confirm('Supprimer cet enregistrement ?')) return
    try {
      await baseAPI.deleteRecord(tableId, recordId)
      onRecordChange?.()
      onClose()
    } catch (e) {
      alert(e.message || 'Erreur lors de la suppression')
    }
  }

  async function loadHistory() {
    if (historyLoaded) return
    try {
      const res = await baseAPI.recordHistory(tableId, recordId)
      setHistory(res.history || (Array.isArray(res) ? res : []))
      setHistoryLoaded(true)
    } catch {
      setHistoryLoaded(true)
    }
  }

  if (!record) {
    return (
      <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-xl z-50 border-l flex items-center justify-center animate-slide-in-right">
        <span className="text-slate-400 text-sm">Chargement…</span>
      </div>
    )
  }

  const activeFields = fields.filter(f => !f.deleted_at)
  const deletedFields = fields.filter(f => f.deleted_at)
  const primaryField = activeFields.find(f => f.is_primary) || activeFields[0]
  const regularFields = activeFields.filter(f => f !== primaryField && f.type !== 'link')
  const linkFields = activeFields.filter(f => f.type === 'link')

  // Find a status-like field for the badge
  const statusField = activeFields.find(f =>
    f.type === 'select' &&
    (f.key === 'status' || f.key === 'statut' || f.name?.toLowerCase() === 'statut' || f.name?.toLowerCase() === 'status')
  )

  const primaryValue = primaryField ? (record.data[primaryField.key] ?? '') : ''

  return (
    <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-xl z-50 border-l border-slate-200 flex flex-col animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 shrink-0">
        <h2 className="text-base font-semibold text-slate-900 truncate flex-1">
          {String(primaryValue) || 'Sans titre'}
        </h2>
        {statusField && record.data[statusField.key] && (
          <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700 shrink-0">
            {record.data[statusField.key]}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleDuplicate}
            title="Dupliquer"
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <Copy size={15} />
          </button>
          <button
            onClick={handleDelete}
            title="Supprimer"
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
          >
            <Trash2 size={15} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 shrink-0">
        <button
          onClick={() => setActiveTab('details')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'details'
              ? 'border-indigo-500 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Détails
        </button>
        <button
          onClick={() => { setActiveTab('history'); loadHistory() }}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'history'
              ? 'border-indigo-500 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          Historique
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'details' ? (
          <div className="p-5 space-y-3">
            {/* Primary field first */}
            {primaryField && (
              <FieldRow
                field={primaryField}
                value={record.data[primaryField.key]}
                isEditing={editingFieldKey === primaryField.key}
                onEdit={() => setEditingFieldKey(primaryField.key)}
                onSave={val => handleSaveField(primaryField.key, val)}
                onCancel={() => setEditingFieldKey(null)}
              />
            )}

            {/* Regular fields */}
            {regularFields.map(field => (
              <FieldRow
                key={field.id}
                field={field}
                value={record.data[field.key]}
                isEditing={editingFieldKey === field.key}
                onEdit={() => setEditingFieldKey(field.key)}
                onSave={val => handleSaveField(field.key, val)}
                onCancel={() => setEditingFieldKey(null)}
              />
            ))}

            {/* Link fields */}
            {linkFields.length > 0 && (
              <div className="pt-3 border-t border-slate-100">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                  Enregistrements liés
                </h3>
                {linkFields.map(field => (
                  <LinkedRecordsSection
                    key={field.id}
                    field={field}
                    value={record.data[field.key]}
                  />
                ))}
              </div>
            )}

            {/* Deleted fields */}
            {deletedFields.length > 0 && (
              <div className="pt-3 border-t border-slate-100">
                <h3 className="text-xs text-slate-400 mb-2">Champs supprimés</h3>
                {deletedFields.map(field => (
                  <div key={field.id} className="flex items-center gap-2 py-1">
                    <span className="text-xs text-slate-300 line-through">{field.name}</span>
                    <span className="text-xs text-slate-300">—</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-y-auto flex-1">
            <HistoryTab history={history} />
          </div>
        )}
      </div>
    </div>
  )
}
