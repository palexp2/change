import { useState, useEffect } from 'react'
import { Modal } from './Modal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from '../lib/api.js'

const TYPE_OPTIONS = [
  { value: 'text', label: 'Texte' },
  { value: 'long_text', label: 'Texte long' },
  { value: 'number', label: 'Nombre' },
  { value: 'date', label: 'Date' },
  { value: 'single_select', label: 'Sélection unique' },
  { value: 'multi_select', label: 'Sélection multiple' },
  { value: 'checkbox', label: 'Case à cocher' },
  { value: 'link', label: 'Lien' },
]

// Modal pour modifier le type d'une colonne issue d'un sync Airtable.
// Le `field` passé contient { id, label, type, options, column_name }.
// On ne touche qu'au field_type (et options) — la donnée stockée n'est pas
// convertie : SQLite typage faible, le type gouverne uniquement le rendu.
export function AirtableFieldEditModal({ isOpen, onClose, field, onSaved }) {
  const { addToast } = useToast()
  const [type, setType] = useState('text')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen || !field) return
    setType(field.type || 'text')
    setError(null)
  }, [isOpen, field])

  // Autosave : le changement de type est persisté dès la sélection (règle
  // « autosave partout » — pas de bouton Enregistrer sur l'édition d'un record
  // existant). En cas d'échec, on restaure la valeur précédente pour que l'UI
  // reflète l'état réellement enregistré.
  async function handleTypeChange(nextType) {
    if (!field || nextType === type) return
    const prevType = type
    setType(nextType)
    setError(null)
    setSaving(true)
    try {
      const updated = await api.airtableFields.update(field.id, { field_type: nextType })
      addToast({ message: 'Type modifié', type: 'success' })
      onSaved?.(updated)
    } catch (e) {
      setType(prevType)
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Modifier la colonne" size="sm">
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Nom</label>
          <div className="text-sm text-slate-700 px-3 py-2 rounded border border-slate-200 bg-slate-50">
            {field?.label}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Le nom provient de la définition de champ — non modifiable ici.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
            Type
            {saving && <span className="ml-2 text-[11px] font-normal normal-case tracking-normal text-slate-400">Enregistrement…</span>}
          </label>
          <select
            data-testid="airtable-field-type"
            value={type}
            onChange={e => handleTypeChange(e.target.value)}
            disabled={saving}
            className="input text-sm w-full"
          >
            {TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400 mt-1">
            Le changement de type modifie l'affichage (filtres, tri, formatage) — la donnée stockée n'est pas reconvertie. Enregistré automatiquement.
          </p>
        </div>

        {error && <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
        </div>
      </div>
    </Modal>
  )
}

export default AirtableFieldEditModal
