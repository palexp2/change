import { useState } from 'react'
import { useToast } from '../contexts/ToastContext.jsx'

// Hook partagé pour l'autosave champ par champ (règle de design : PATCH au
// blur / au changement, pas de bouton Enregistrer). Remplace la plomberie
// recopiée dans chaque modale/fiche d'édition :
//
//   const save = async (k, v) => {
//     if (isNew) return
//     if ((account[k] ?? '') === (v ?? '')) return
//     setSaving(true)
//     try { onSaved(await api.prepaid.accounts.update(account.id, { [k]: v === '' ? null : v })) }
//     catch (e) { addToast(...); set(k, account[k]) }
//     finally { setSaving(false) }
//   }
//
// Usage :
//
//   const { save, saving } = useAutosave(record, patch => api.x.update(record.id, patch), {
//     onSaved: updated => ...,                 // reçoit le retour de l'updater
//     onError: (key, prevValue, err) => ...,   // rollback local du champ
//   })
//   ...
//   <input onBlur={e => save('label', e.target.value)} />
//
// Options :
// - enabled (défaut true) : false pour un record en création (pas encore d'id)
//   — save() ne fait alors rien (l'ancien garde `if (isNew) return`).
// - emptyToNull (défaut true) : convertit '' → null avant l'envoi.
// - compare (défaut (a, b) => (a ?? '') === (b ?? '')) : skip du save quand la
//   valeur est inchangée. Passer `() => false` pour toujours sauvegarder, ou
//   une comparaison String() pour les champs numériques.
// - errorMessage (défaut e => `Sauvegarde échouée : ${e.message}`) : texte du
//   toast d'erreur.
export function useAutosave(record, updater, {
  enabled = true,
  emptyToNull = true,
  compare = (a, b) => (a ?? '') === (b ?? ''),
  errorMessage = (e) => `Sauvegarde échouée : ${e.message}`,
  onSaved,
  onError,
} = {}) {
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()

  const save = async (key, value) => {
    if (!enabled || !record) return
    if (compare(record[key], value)) return
    setSaving(true)
    try {
      const result = await updater({ [key]: emptyToNull && value === '' ? null : value })
      onSaved?.(result)
    } catch (e) {
      addToast({ message: errorMessage(e), type: 'error' })
      onError?.(key, record[key], e)
    } finally {
      setSaving(false)
    }
  }

  return { save, saving }
}

export default useAutosave
