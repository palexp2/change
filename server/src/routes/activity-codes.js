import db from '../db/database.js'
import { requireAdmin } from '../middleware/auth.js'
import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'

const usersOf = db.prepare(`
  SELECT u.id, u.name
  FROM activity_code_users acu
  JOIN users u ON u.id = acu.user_id
  WHERE acu.code_id = ?
  ORDER BY u.name COLLATE NOCASE
`)

export default crudRouter(RECORD_REGISTRY.activity_codes, {
  omit: ['list'],
  extend(router) {
    // GET /api/activity-codes
    //   - défaut: actifs uniquement, filtrés par visibilité pour req.user
    //   - ?include_inactive=1   : inclut aussi les inactifs
    //   - ?for_user_id=X (admin): filtre comme si on était cet user
    //   - ?all=1         (admin): bypass complet du filtre de visibilité
    router.get('/', (req, res) => {
      const { include_inactive, for_user_id, all } = req.query
      const isAdmin = req.user.role === 'admin'
      if ((all || for_user_id) && !isAdmin) return res.status(403).json({ error: 'Accès refusé' })

      const conds = ['deleted_at IS NULL']
      const params = []
      if (!include_inactive) conds.push('active = 1')
      if (!all) {
        // Visibilité : public (aucune ligne dans activity_code_users) OU assigné au user cible.
        conds.push(`(
          NOT EXISTS (SELECT 1 FROM activity_code_users acu WHERE acu.code_id = activity_codes.id)
          OR EXISTS (SELECT 1 FROM activity_code_users acu WHERE acu.code_id = activity_codes.id AND acu.user_id = ?)
        )`)
        params.push(for_user_id || req.user.id)
      }
      const rows = db.prepare(`SELECT * FROM activity_codes WHERE ${conds.join(' AND ')} ORDER BY name COLLATE NOCASE`).all(...params)
      res.json({ data: rows })
    })

    // Liste vide ⇒ code public (visible à tous).
    router.get('/:id/users', requireAdmin, (req, res) => {
      const code = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
      if (!code) return res.status(404).json({ error: 'Not found' })
      res.json({ data: usersOf.all(req.params.id) })
    })

    // Body : { user_ids: [...] }. Tableau vide ⇒ rend le code public.
    router.put('/:id/users', requireAdmin, (req, res) => {
      const code = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
      if (!code) return res.status(404).json({ error: 'Not found' })
      const { user_ids } = req.body || {}
      if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids doit être un tableau' })
      const valid = new Set(db.prepare('SELECT id FROM users').all().map(u => u.id))
      for (const uid of user_ids) {
        if (!valid.has(uid)) return res.status(400).json({ error: `user_id inconnu: ${uid}` })
      }
      db.transaction(() => {
        db.prepare('DELETE FROM activity_code_users WHERE code_id = ?').run(req.params.id)
        const ins = db.prepare('INSERT INTO activity_code_users (code_id, user_id) VALUES (?, ?)')
        for (const uid of user_ids) ins.run(req.params.id, uid)
      })()
      res.json({ data: usersOf.all(req.params.id) })
    })
  },
})
