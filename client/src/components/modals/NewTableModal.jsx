import { useState } from 'react'
import { Modal } from '../Modal.jsx'
import { Table2, Plus } from 'lucide-react'

const ICONS = ['Table2', 'Users', 'Building2', 'ShoppingCart', 'Package', 'FileText',
  'Calendar', 'Bookmark', 'Tag', 'Star', 'Heart', 'Globe', 'Folder', 'Database', 'List', 'Grid3x3']

const COLORS = ['indigo', 'violet', 'blue', 'sky', 'emerald', 'teal', 'amber', 'orange', 'rose', 'pink', 'slate']

export function NewTableModal({ open, onClose, onCreate }) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('Table2')
  const [color, setColor] = useState('indigo')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return setError('Nom requis')
    setSaving(true)
    setError('')
    try {
      await onCreate({ name: name.trim(), icon, color })
      setName('')
      setIcon('Table2')
      setColor('indigo')
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={open} onClose={onClose} title="Nouvelle table" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Nom de la table</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="input"
            placeholder="Ex: Projets, Clients, Tâches…"
            autoFocus
          />
        </div>

        <div>
          <label className="label">Couleur</label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full bg-${c}-500 transition-all ${color === c ? 'ring-2 ring-offset-1 ring-slate-700 scale-110' : 'hover:scale-105'}`}
              />
            ))}
          </div>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary flex items-center gap-2">
            <Plus size={15} />
            {saving ? 'Création…' : 'Créer la table'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
