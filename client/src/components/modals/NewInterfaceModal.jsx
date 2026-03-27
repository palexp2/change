import { useState } from 'react'
import { Modal } from '../Modal.jsx'
import api from '../../lib/api.js'

const ICONS = ['LayoutDashboard', 'BarChart3', 'PieChart', 'TrendingUp', 'List', 'Table2', 'Zap', 'Star', 'Globe', 'Home']
const COLORS = ['indigo', 'blue', 'green', 'emerald', 'violet', 'rose', 'amber', 'cyan']
const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'sales', label: 'Ventes' },
  { value: 'support', label: 'Support' },
  { value: 'ops', label: 'Opérations' },
]

export function NewInterfaceModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('LayoutDashboard')
  const [color, setColor] = useState('indigo')
  const [roles, setRoles] = useState(['admin', 'sales', 'support', 'ops'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function toggleRole(role) {
    setRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role])
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return setError('Le nom est requis')
    setSaving(true)
    setError('')
    try {
      const res = await api.interfaces.create({ name: name.trim(), icon, color, role_access: roles })
      onCreated(res)
    } catch (err) {
      setError(err.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouvelle interface" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Nom</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="input"
            placeholder="Mon dashboard"
            required
          />
        </div>

        <div>
          <label className="label">Icône</label>
          <div className="flex flex-wrap gap-2">
            {ICONS.map(ic => (
              <button
                key={ic}
                type="button"
                onClick={() => setIcon(ic)}
                className={`p-2 rounded border text-sm transition-colors ${icon === ic ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}
              >
                {ic.replace(/([A-Z])/g, ' $1').trim().slice(0, 8)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Couleur</label>
          <div className="flex gap-2">
            {COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-7 h-7 rounded-full bg-${c}-500 ring-2 ring-offset-2 transition-all ${color === c ? `ring-${c}-500` : 'ring-transparent'}`}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="label">Accès par rôle</label>
          <div className="flex flex-wrap gap-2">
            {ROLES.map(r => (
              <label key={r.value} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={roles.includes(r.value)}
                  onChange={() => toggleRole(r.value)}
                  className="rounded"
                />
                <span className="text-sm">{r.label}</span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Création…' : 'Créer'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
