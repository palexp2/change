import { useState, useEffect } from 'react'
import { Modal } from './Modal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import api from '../lib/api.js'

// Modal pour créer ou éditer un champ custom (texte ou nombre).
// Si `editing` est passé, on est en mode édition (le type est figé).
export function CustomFieldModal({ isOpen, onClose, erpTable, editing, onSaved }) {
  const { addToast } = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const [decimals, setDecimals] = useState(2)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    if (editing) {
      setName(editing.name || '')
      setType(editing.type || 'text')
      setDecimals(editing.decimals ?? 2)
    } else {
      setName('')
      setType('text')
      setDecimals(2)
    }
    setError(null)
  }, [isOpen, editing])

  async function handleSubmit(e) {
    e?.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Nom requis'); return }
    setSaving(true)
    try {
      const payload = editing
        ? { name: name.trim(), ...(type === 'number' ? { decimals } : {}) }
        : { name: name.trim(), type, ...(type === 'number' ? { decimals } : {}) }
      const result = editing
        ? await api.customFields.update(editing.id, payload)
        : await api.customFields.create(erpTable, payload)
      addToast({ message: editing ? 'Champ modifié' : 'Champ créé', type: 'success' })
      onSaved?.(result)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Modifier le champ' : 'Nouveau champ'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Nom</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="input text-sm w-full"
            placeholder="ex: Priorité interne"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Type</label>
          <div className="flex gap-2">
            <label className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${type === 'text' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
              <input
                type="radio"
                name="cf-type"
                value="text"
                checked={type === 'text'}
                onChange={() => setType('text')}
                disabled={!!editing}
                className="sr-only"
              />
              Texte
            </label>
            <label className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${type === 'number' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50 text-slate-700'} ${editing ? 'opacity-60 cursor-not-allowed' : ''}`}>
              <input
                type="radio"
                name="cf-type"
                value="number"
                checked={type === 'number'}
                onChange={() => setType('number')}
                disabled={!!editing}
                className="sr-only"
              />
              Nombre
            </label>
          </div>
          {editing && (
            <p className="text-[11px] text-slate-400 mt-1">Le type ne peut pas être modifié après création.</p>
          )}
        </div>

        {type === 'number' && (
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Décimales (0 à 5)</label>
            <input
              type="number"
              min={0}
              max={5}
              value={decimals}
              onChange={e => setDecimals(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))}
              className="input text-sm w-24"
            />
          </div>
        )}

        {error && <div className="rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : (editing ? 'Enregistrer' : 'Créer')}</button>
        </div>
      </form>
    </Modal>
  )
}

export default CustomFieldModal
