// Restauration accessible à tout utilisateur authentifié — sert le pattern
// "Undo toast" côté UI (toast 'Annuler' après suppression). Le restore admin
// (admin.js) reste utilisé par la page Corbeille pour la rétroactivité.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const UNDOABLE_TABLES = new Set([
  'companies', 'contacts', 'orders', 'products', 'shipments', 'returns',
  'projects', 'assemblages', 'tasks', 'interactions', 'serial_numbers',
])

router.post('/:table/:id', (req, res) => {
  if (!UNDOABLE_TABLES.has(req.params.table)) {
    return res.status(400).json({ error: 'Table non supportée pour undo' })
  }
  const result = db.prepare(
    `UPDATE ${req.params.table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`
  ).run(req.params.id)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Enregistrement introuvable ou déjà restauré' })
  }
  res.json({ ok: true })
})

export default router
