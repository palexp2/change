import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'

const router = Router()
router.use(requireAuth)

// GET /api/activity-codes
//   - défaut: actifs uniquement, filtrés par visibilité pour req.user
//   - ?include_inactive=1   : inclut aussi les inactifs
//   - ?for_user_id=X (admin): filtre comme si on était cet user (pour la vue admin d'une feuille)
//   - ?all=1         (admin): bypass complet du filtre de visibilité (page de gestion)
router.get('/', (req, res) => {
  const { include_inactive, for_user_id, all } = req.query
  const isAdmin = req.user.role === 'admin'

  // Sécurité : seul un admin peut bypass le filtre ou viser un autre user
  if ((all || for_user_id) && !isAdmin) {
    return res.status(403).json({ error: 'Accès refusé' })
  }

  const conds = ['deleted_at IS NULL']
  const params = []
  if (!include_inactive) conds.push('active = 1')

  if (!all) {
    // Filtre de visibilité : public (0 lignes dans activity_code_users)
    // OU explicitement assigné au user cible.
    const targetUserId = for_user_id || req.user.id
    conds.push(`(
      NOT EXISTS (SELECT 1 FROM activity_code_users acu WHERE acu.code_id = activity_codes.id)
      OR EXISTS (SELECT 1 FROM activity_code_users acu WHERE acu.code_id = activity_codes.id AND acu.user_id = ?)
    )`)
    params.push(targetUserId)
  }

  const sql = `SELECT * FROM activity_codes WHERE ${conds.join(' AND ')} ORDER BY name COLLATE NOCASE`
  const rows = db.prepare(sql).all(...params)
  res.json({ data: rows })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const { name, description, active, payable, rsde_default } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name requis' })
  const id = uuidv4()
  db.prepare(`
    INSERT INTO activity_codes (id, name, description, active, payable, rsde_default)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(name).trim(),
    description || null,
    active === false ? 0 : 1,
    payable === false ? 0 : 1,
    rsde_default ? 1 : 0,
  )
  const row = db.prepare('SELECT * FROM activity_codes WHERE id = ?').get(id)
  emitEntity('activity_code', 'created', id, row, req.user?.id)
  res.status(201).json(row)
})

const PATCHABLE = new Set(['name', 'description', 'active', 'payable', 'rsde_default'])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    if (!PATCHABLE.has(k)) continue
    let v = rawV
    if (k === 'active' || k === 'payable' || k === 'rsde_default') v = v ? 1 : 0
    else if (v === '' || v === undefined) v = null
    else if (k === 'name') {
      v = String(v).trim()
      if (!v) return res.status(400).json({ error: 'name ne peut pas être vide' })
    }
    updates.push(`${k} = ?`)
    params.push(v)
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(req.params.id)
  db.prepare(`UPDATE activity_codes SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  const updated = db.prepare('SELECT * FROM activity_codes WHERE id = ?').get(req.params.id)
  emitEntity('activity_code', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// DELETE — soft delete (cohérent avec le reste de l'app)
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE activity_codes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  emitEntity('activity_code', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ success: true })
})

// GET /api/activity-codes/:id/users — liste des users explicitement assignés à ce code (admin)
// Une liste vide ⇒ code public (visible à tous).
router.get('/:id/users', requireAdmin, (req, res) => {
  const code = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!code) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(`
    SELECT u.id, u.name
    FROM activity_code_users acu
    JOIN users u ON u.id = acu.user_id
    WHERE acu.code_id = ?
    ORDER BY u.name COLLATE NOCASE
  `).all(req.params.id)
  res.json({ data: rows })
})

// PUT /api/activity-codes/:id/users — remplace l'ensemble des users assignés (admin)
// Body : { user_ids: [...] }. Tableau vide ⇒ rend le code public.
router.put('/:id/users', requireAdmin, (req, res) => {
  const code = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!code) return res.status(404).json({ error: 'Not found' })
  const { user_ids } = req.body || {}
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids doit être un tableau' })

  // Valide que tous les user_ids existent
  const valid = new Set(db.prepare('SELECT id FROM users').all().map(u => u.id))
  for (const uid of user_ids) {
    if (!valid.has(uid)) return res.status(400).json({ error: `user_id inconnu: ${uid}` })
  }

  db.transaction(() => {
    db.prepare('DELETE FROM activity_code_users WHERE code_id = ?').run(req.params.id)
    const ins = db.prepare('INSERT INTO activity_code_users (code_id, user_id) VALUES (?, ?)')
    for (const uid of user_ids) ins.run(req.params.id, uid)
  })()

  const rows = db.prepare(`
    SELECT u.id, u.name
    FROM activity_code_users acu
    JOIN users u ON u.id = acu.user_id
    WHERE acu.code_id = ?
    ORDER BY u.name COLLATE NOCASE
  `).all(req.params.id)
  res.json({ data: rows })
})

export default router
