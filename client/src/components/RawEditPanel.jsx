import { useState, useEffect, useRef } from 'react'
import { Loader2, AlertCircle, Check } from 'lucide-react'

// Panneau générique d'édition « toutes colonnes DB » d'un record. Le caller
// fournit le schéma (via schemaLoader), la row courante (record), un callback
// onSave(col, value) qui appelle l'endpoint PATCH /raw côté serveur, et
// optionnellement des groupes de colonnes pour l'affichage.

function pickInputType(col) {
  const n = col.name
  if (col.type === 'INTEGER') {
    if (/^is_|_manual$|_verified$|active$/.test(n)) return 'checkbox'
    return 'integer'
  }
  if (col.type === 'REAL') return 'number'
  if (n === 'notes') return 'textarea'
  if (/_at$|_date$/.test(n)) {
    if (/^document_date$|^due_date$|^date_/.test(n)) return 'date'
    return 'datetime-local'
  }
  return 'text'
}

function isoToLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function localInputToIso(local) {
  if (!local) return null
  const d = new Date(local)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

function formatForInput(value, inputType) {
  if (value === null || value === undefined) return ''
  if (inputType === 'datetime-local') return isoToLocalInput(value)
  if (inputType === 'checkbox') return value ? 1 : 0
  return value
}
function parseFromInput(draft, inputType) {
  if (draft === '' || draft === null || draft === undefined) return null
  if (inputType === 'datetime-local') return localInputToIso(draft)
  if (inputType === 'number') return Number(draft)
  if (inputType === 'integer') return Math.trunc(Number(draft))
  return draft
}

export default function RawEditPanel({
  schemaLoader,
  record,
  onSave,
  groups,            // [{ title, cols: [name, ...] }]
  testIdPrefix = 'raw-edit',
}) {
  const [schema, setSchema] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [savingCol, setSavingCol] = useState(null)
  const [savedCol, setSavedCol] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const savedTimer = useRef(null)

  useEffect(() => {
    if (schema) return
    schemaLoader()
      .then(r => setSchema(r.columns || []))
      .catch(e => setLoadError(e.message || 'Schéma indisponible'))
  }, [schema, schemaLoader])

  async function commit(colName, value) {
    setSavingCol(colName)
    setFieldErrors(prev => ({ ...prev, [colName]: null }))
    try {
      const res = await onSave(colName, value)
      if (res?.rejected && res.rejected[colName]) {
        setFieldErrors(prev => ({ ...prev, [colName]: res.rejected[colName] }))
      } else {
        setSavedCol(colName)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSavedCol(null), 1500)
      }
    } catch (err) {
      setFieldErrors(prev => ({ ...prev, [colName]: err.message || 'Erreur' }))
    } finally {
      setSavingCol(null)
    }
  }

  if (loadError) {
    return (
      <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2 flex items-center gap-1.5">
        <AlertCircle size={12} /> {loadError}
      </div>
    )
  }
  if (!schema) {
    return (
      <div className="text-xs text-slate-400 flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" /> Chargement du schéma…
      </div>
    )
  }

  const knownCols = new Set((groups || []).flatMap(g => g.cols))
  const otherCols = schema.map(c => c.name).filter(n => !knownCols.has(n))
  const effectiveGroups = [
    ...(groups || []),
    ...(otherCols.length ? [{ title: groups?.length ? 'Autres' : 'Colonnes', cols: otherCols }] : []),
  ]

  return (
    <div className="space-y-5">
      {effectiveGroups.map(group => {
        const colsInGroup = group.cols
          .map(name => schema.find(c => c.name === name))
          .filter(Boolean)
        if (colsInGroup.length === 0) return null
        return (
          <div key={group.title}>
            <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">{group.title}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3">
              {colsInGroup.map(col => (
                <FieldRow
                  key={col.name}
                  col={col}
                  value={record?.[col.name]}
                  inputType={pickInputType(col)}
                  saving={savingCol === col.name}
                  saved={savedCol === col.name}
                  error={fieldErrors[col.name]}
                  testIdPrefix={testIdPrefix}
                  onSave={v => commit(col.name, v)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FieldRow({ col, value, inputType, saving, saved, error, testIdPrefix, onSave }) {
  const [draft, setDraft] = useState(formatForInput(value, inputType))
  const initialRef = useRef(formatForInput(value, inputType))

  useEffect(() => {
    const next = formatForInput(value, inputType)
    if (next !== initialRef.current) {
      initialRef.current = next
      setDraft(next)
    }
  }, [value, inputType])

  const readOnly = col.name === 'id'
  const testId = `${testIdPrefix}-input-${col.name}`
  const commonProps = {
    className: `w-full text-sm border rounded-md px-2 py-1.5 ${error ? 'border-red-300 bg-red-50' : 'border-slate-300'} ${readOnly ? 'bg-slate-50 text-slate-500' : ''}`,
    disabled: readOnly,
    'data-testid': testId,
  }

  function commit() {
    if (readOnly) return
    if (draft === initialRef.current) return
    const payload = parseFromInput(draft, inputType)
    initialRef.current = formatForInput(payload, inputType)
    onSave(payload)
  }

  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1 flex items-center gap-2">
        <code className="text-[11px] text-slate-700">{col.name}</code>
        <span className="text-[10px] text-slate-400">{col.type}{col.pk ? ' · PK' : ''}{col.notnull ? ' · NOT NULL' : ''}</span>
        <span className="ml-auto flex items-center gap-1">
          {saving && <Loader2 size={11} className="animate-spin text-slate-400" />}
          {saved && !saving && <Check size={11} className="text-emerald-600" />}
        </span>
      </label>
      {inputType === 'checkbox' ? (
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={!!draft}
            onChange={e => {
              const next = e.target.checked ? 1 : 0
              setDraft(next)
              initialRef.current = next
              onSave(next)
            }}
            disabled={readOnly}
            data-testid={testId}
          />
          <span className="text-xs text-slate-500">{draft ? 'true (1)' : 'false (0)'}</span>
        </label>
      ) : inputType === 'textarea' ? (
        <textarea
          {...commonProps}
          rows={3}
          value={draft ?? ''}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          {...commonProps}
          type={
            inputType === 'number' || inputType === 'integer' ? 'number'
            : inputType === 'date' ? 'date'
            : inputType === 'datetime-local' ? 'datetime-local'
            : 'text'
          }
          step={inputType === 'number' ? '0.01' : (inputType === 'integer' ? '1' : undefined)}
          value={draft ?? ''}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
        />
      )}
      {error && (
        <div className="mt-1 text-[11px] text-red-700 flex items-center gap-1">
          <AlertCircle size={10} /> {error}
        </div>
      )}
    </div>
  )
}
