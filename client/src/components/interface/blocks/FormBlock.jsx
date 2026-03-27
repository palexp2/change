import { useState, useEffect } from 'react'
import { CellRenderer } from '../../grid/CellRenderer.jsx'
import { baseAPI } from '../../../hooks/useBaseAPI.js'
import { useToast } from '../../ui/ToastProvider.jsx'
import { Check } from 'lucide-react'

const SKIP_TYPES = ['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at']

function isFieldVisible(fc, formData) {
  if (!fc.visible_if) return true
  const { field_key, op, value } = fc.visible_if
  const current = formData[field_key]
  switch (op) {
    case 'is_empty':     return current == null || current === ''
    case 'is_not_empty': return current != null && current !== ''
    case 'equals':       return current === value
    case 'not_equals':   return current !== value
    default:             return true
  }
}

function FormFieldInput({ fc, field, value, onChange }) {
  // For boolean, use a simple checkbox instead of CellRenderer (which toggles on mount)
  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-indigo-600"
      />
    )
  }
  return (
    <CellRenderer
      field={field}
      value={value}
      editing
      onCommit={val => onChange(val)}
      onCancel={() => {}}
    />
  )
}

export default function FormBlock({ block, config }) {
  const [formData, setFormData] = useState({})
  const [fields, setFields] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [errors, setErrors] = useState({})
  const { addToast } = useToast()

  useEffect(() => {
    if (!config.table_id) return
    baseAPI.fields(config.table_id)
      .then(res => setFields((res.fields || []).filter(f => !f.deleted_at && !SKIP_TYPES.includes(f.type))))
      .catch(() => {})
  }, [config.table_id])

  const fieldConfigs = config.field_configs || []

  function handleChange(fieldKey, value) {
    setFormData(prev => ({ ...prev, [fieldKey]: value }))
    setErrors(prev => { const n = { ...prev }; delete n[fieldKey]; return n })
  }

  async function handleSubmit() {
    const newErrors = {}
    for (const fc of fieldConfigs) {
      if (!isFieldVisible(fc, formData)) continue
      if (fc.required && (formData[fc.field_key] == null || formData[fc.field_key] === '')) {
        newErrors[fc.field_key] = 'Ce champ est obligatoire'
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    // Only submit visible fields
    const submitData = {}
    for (const fc of fieldConfigs) {
      if (isFieldVisible(fc, formData)) {
        submitData[fc.field_key] = formData[fc.field_key] ?? null
      }
    }

    setSubmitting(true)
    try {
      await baseAPI.createRecord(config.table_id, { data: submitData })
      if (config.on_success?.message) {
        setSubmitted(true)
      } else {
        addToast({ message: config.on_success?.message || 'Enregistrement créé', type: 'success' })
        setFormData({})
        setErrors({})
      }
    } catch (err) {
      addToast({ message: err.message || 'Erreur', type: 'error' })
    }
    setSubmitting(false)
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center mb-2">
          <Check size={20} className="text-green-600" />
        </div>
        <p className="text-sm text-gray-700">{config.on_success?.message || 'Enregistrement créé !'}</p>
        <button
          onClick={() => { setSubmitted(false); setFormData({}); setErrors({}) }}
          className="mt-3 text-xs text-indigo-600 hover:text-indigo-700"
        >
          Ajouter un autre
        </button>
      </div>
    )
  }

  if (!config.table_id || fieldConfigs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
        {!config.table_id ? 'Configurer une table' : 'Ajouter des champs dans le panel de configuration'}
      </div>
    )
  }

  // Render fields with half-width pairs
  const rendered = []
  let i = 0
  while (i < fieldConfigs.length) {
    const fc = fieldConfigs[i]
    if (!isFieldVisible(fc, formData)) { i++; continue }
    const field = fields.find(f => f.key === fc.field_key)
    if (!field) { i++; continue }

    const nextFc = fieldConfigs[i + 1]
    const nextField = nextFc ? fields.find(f => f.key === nextFc.field_key) : null
    const nextVisible = nextFc && isFieldVisible(nextFc, formData) && nextField

    if (fc.width === 'half' && nextFc?.width === 'half' && nextVisible) {
      rendered.push(
        <div key={`pair-${i}`} className="grid grid-cols-2 gap-3">
          <FieldRow fc={fc} field={field} value={formData[fc.field_key]} error={errors[fc.field_key]} onChange={handleChange} />
          <FieldRow fc={nextFc} field={nextField} value={formData[nextFc.field_key]} error={errors[nextFc.field_key]} onChange={handleChange} />
        </div>
      )
      i += 2
    } else {
      rendered.push(
        <FieldRow key={fc.field_key} fc={fc} field={field} value={formData[fc.field_key]} error={errors[fc.field_key]} onChange={handleChange} />
      )
      i++
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      {rendered}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full px-4 py-2.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium"
      >
        {submitting ? 'Envoi…' : config.submit_label || 'Enregistrer'}
      </button>
    </div>
  )
}

function FieldRow({ fc, field, value, error, onChange }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {fc.label || field.name}
        {fc.required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <FormFieldInput fc={fc} field={field} value={value} onChange={val => onChange(fc.field_key, val)} />
      {fc.help_text && <p className="text-xs text-gray-400 mt-1">{fc.help_text}</p>}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  )
}
