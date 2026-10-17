// Briques des petites fiches modales à autosave (dettes, comptes prépayés,
// frais payés d'avance, profils fournisseurs) : classes, champ texte lié au
// formulaire, zone Notes et pied « Créer / Supprimer + état de sauvegarde ».
// Chaque page garde ses champs ; seule la plomberie répétée vit ici.
import { useState } from 'react'
import { useToast } from '../contexts/ToastContext.jsx'

export const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
export const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// `field(k, label, props)` : input texte lié à `form[k]`, édité via `set`,
// persisté au blur via `save` (chaîne vide → null).
export function makeTextField(form, set, save) {
  return (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value.trim())}
        {...props}
      />
    </div>
  )
}

export function NotesField({ form, set, save, k = 'notes', label = 'Notes', rows = 2 }) {
  return (
    <div className="col-span-2">
      <label className={labelCls}>{label}</label>
      <textarea className={inputCls} rows={rows} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value)} />
    </div>
  )
}

// Action de création : exécute `fn`, affiche l'erreur en toast, expose `saving`.
export function useCreateAction(fn) {
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const run = async () => {
    setSaving(true)
    try { await fn() } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setSaving(false) }
  }
  return { run, saving }
}

// Pied de fiche : création → Annuler / Créer (pas encore d'id, autosave
// impossible) ; fiche existante → Supprimer + état de l'autosave.
export function AutosaveFooter({ isNew, saving, autosaving, onClose, onCreate, onDelete, createTestId }) {
  const { addToast } = useToast()
  return (
    <div className="flex items-center justify-between mt-4">
      {isNew ? (
        <div className="flex w-full justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
          <button onClick={onCreate} disabled={saving} data-testid={createTestId}
            className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
            {saving ? 'Création…' : 'Créer'}
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={async () => {
              try { await onDelete(); onClose() }
              catch (e) { addToast({ message: e.message, type: 'error' }) }
            }}
            className="text-sm text-red-600 hover:underline"
          >
            Supprimer
          </button>
          <span className="text-xs text-slate-400">{autosaving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
        </>
      )}
    </div>
  )
}
