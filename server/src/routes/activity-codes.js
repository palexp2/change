import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/activity-codes  (par défaut: actifs uniquement)
router.get('/', (req, res) => {
  const { include_inactive } = req.query
  let where = 'WHERE deleted_at IS NULL'
  if (!include_inactive) where += ' AND active = 1'
  const rows = db.prepare(`SELECT * FROM activity_codes ${where} ORDER BY name COLLATE NOCASE`).all()
  res.json({ data: rows })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const { name, description, active, payable } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name requis' })
  const id = uuidv4()
  db.prepare(`
    INSERT INTO activity_codes (id, name, description, active, payable)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    String(name).trim(),
    description || null,
    active === false ? 0 : 1,
    payable === false ? 0 : 1,
  )
  res.status(201).json(db.prepare('SELECT * FROM activity_codes WHERE id = ?').get(id))
})

const PATCHABLE = new Set(['name', 'description', 'active', 'payable'])

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const updates = []
  const params = []
  for (const [k, rawV] of Object.entries(req.body || {})) {
    if (!PATCHABLE.has(k)) continue
    let v = rawV
    if (k === 'active' || k === 'payable') v = v ? 1 : 0
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
  res.json(db.prepare('SELECT * FROM activity_codes WHERE id = ?').get(req.params.id))
})

// DELETE — soft delete (cohérent avec le reste de l'app)
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM activity_codes WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE activity_codes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(req.params.id)
  res.json({ success: true })
})

export default router
