// Restauration accessible à tout utilisateur authentifié — sert le pattern
// "Undo toast" côté UI (toast 'Annuler' après suppression). Le restore admin
// (admin.js) reste utilisé par la page Corbeille pour la rétroactivité.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { undoLastEdit, asRestoreOfDelete } from '../services/undoLastEdit.js'

const router = Router()
router.use(requireAuth)

const UNDOABLE_TABLES = new Set([
  'companies', 'contacts', 'orders', 'products', 'shipments', 'returns',
  'projects', 'assemblages', 'tasks', 'interactions', 'serial_numbers',
  'ops_issues',
])

// Ctrl+Z : annule la dernière modification de l'utilisateur (voir
// services/undoLastEdit.js). Le relais de redémarrage ne tient pas l'historique.
router.post('/last', (req, res) => {
  if (process.env.ERP_ROLE === 'standby') return res.status(503).json({ error: 'Serveur en redémarrage' })
  const ms = req.body?.localAgeMs == null ? NaN : Number(req.body.localAgeMs)
  res.json(undoLastEdit(req.user.id, { localAgeMs: Number.isFinite(ms) && ms >= 0 ? ms : null }))
})

router.post('/:table/:id', (req, res) => {
  if (!UNDOABLE_TABLES.has(req.params.table)) {
    return res.status(400).json({ error: 'Table non supportée pour undo' })
  }
  const restore = () => db.prepare(
    `UPDATE ${req.params.table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`
  ).run(req.params.id)
  const result = process.env.ERP_ROLE === 'standby' ? restore() : asRestoreOfDelete(req.params.table, req.params.id, restore)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Enregistrement introuvable ou déjà restauré' })
  }
  res.json({ ok: true })
})

export default router
