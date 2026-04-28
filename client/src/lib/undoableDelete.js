// Helper "undo toast" pour les suppressions soft-delete.
// Usage typique :
//
//   import { useUndoableDelete } from '../lib/undoableDelete.js'
//   const undoableDelete = useUndoableDelete()
//   ...
//   await undoableDelete({
//     table: 'tasks',
//     id: task.id,
//     deleteFn: () => api.tasks.delete(task.id),
//     label: 'Tâche supprimée',
//     onChange: () => loadTasks(),
//   })
//
// Le helper :
//  1. exécute deleteFn()
//  2. appelle onChange() pour rafraîchir l'UI
//  3. affiche un toast 'undo' pendant 8 s avec un bouton Annuler
//  4. clic Annuler → POST /undo/:table/:id, puis onChange() à nouveau
//
// Les tables supportées sont les 11 entités soft-delete (cf. server/routes/undo.js).
import { useToast } from '../contexts/ToastContext.jsx'
import api from './api.js'

const UNDO_DURATION_MS = 8000

export function useUndoableDelete() {
  const { addToast } = useToast()

  return async function undoableDelete({ table, id, ids, deleteFn, label, onChange }) {
    if (!table || !deleteFn || (id == null && !ids?.length)) {
      throw new Error('undoableDelete: table + (id|ids) + deleteFn requis')
    }
    const idsArr = ids?.length ? ids : [id]
    await deleteFn()
    onChange?.()
    addToast({
      type: 'undo',
      message: label || 'Élément supprimé',
      duration: UNDO_DURATION_MS,
      action: {
        label: 'Annuler',
        onClick: async () => {
          try {
            await Promise.all(idsArr.map(rid => api.undo.restore(table, rid)))
            onChange?.()
            addToast({ type: 'success', message: 'Restauré', duration: 2000 })
          } catch (e) {
            addToast({ type: 'error', message: 'Restauration échouée : ' + (e.message || 'erreur'), duration: 5000 })
          }
        },
      },
    })
  }
}
