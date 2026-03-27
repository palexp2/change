import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'
import { baseAPI } from '../hooks/useBaseAPI.js'
import { CellRenderer } from '../components/grid/CellRenderer.jsx'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'

const READONLY_TYPES = new Set(['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at'])

export default function FormView() {
  const { slug } = useParams()
  const { addToast } = useToast()

  const [table, setTable] = useState(null)
  const [fields, setFields] = useState([])
  const [formData, setFormData] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    baseAPI.tables().then(res => {
      const found = (res.tables || []).find(t => t.slug === slug || t.id === slug)
      if (!found) return
      setTable(found)
      baseAPI.fields(found.id).then(r => {
        const editable = (r.fields || []).filter(f => !f.deleted_at && !READONLY_TYPES.has(f.type))
        setFields(editable)
      })
    })
  }, [slug])

  async function handleSubmit(e) {
    e.preventDefault()

    const missing = fields.filter(f => f.required && (formData[f.key] === undefined || formData[f.key] === null || formData[f.key] === ''))
    if (missing.length > 0) {
      addToast({ message: `Champs obligatoires : ${missing.map(f => f.name).join(', ')}`, type: 'error' })
      return
    }

    setSubmitting(true)
    try {
      await baseAPI.createRecord(table.id, formData)
      setSubmitted(true)
    } catch (e) {
      addToast({ message: e.message || 'Erreur lors de la soumission', type: 'error' })
    }
    setSubmitting(false)
  }

  if (!table) {
    return (
      <div className="p-12 text-center text-gray-400">Chargement...</div>
    )
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto mt-20 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check size={28} className="text-green-600" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Enregistrement créé !</h2>
        <p className="text-gray-500 mb-6">Votre réponse a été enregistrée avec succès.</p>
        <button onClick={() => { setSubmitted(false); setFormData({}) }}
          className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
          Soumettre une autre réponse
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto mt-12 mb-12 px-4">
      <div className="bg-white rounded-xl border shadow-sm p-8">
        <div className="flex items-center gap-3 mb-6">
          {table.icon && (
            <DynamicIcon name={table.icon} size={24} className={`text-${table.color || 'indigo'}-600`} />
          )}
          <h1 className="text-xl font-semibold">{table.name}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {fields.map(field => (
            <div key={field.id}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.name}
                {field.required ? <span className="text-red-500 ml-0.5">*</span> : ''}
              </label>
              <CellRenderer
                field={field}
                value={formData[field.key] ?? null}
                mode="edit"
                onChange={val => setFormData(prev => ({ ...prev, [field.key]: val }))}
                onCancel={() => {}}
              />
            </div>
          ))}

          <button type="submit" disabled={submitting}
            className="w-full px-4 py-3 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
            {submitting ? 'Envoi en cours...' : 'Soumettre'}
          </button>
        </form>
      </div>
    </div>
  )
}
