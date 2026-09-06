import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const VALID_OPS = new Set(['AND', 'OR'])
const VALID_OPERATORS = new Set(['populated', 'empty', 'equals', 'not_equals'])

// Validation récursive de l'arbre de conditions. Forme acceptée :
//   { op: 'AND'|'OR', rules: [ leaf | group, ... ] }
//   leaf = { field: string, operator: 'populated'|'empty'|'equals'|'not_equals', value?: any }
function validateConditions(node, depth = 0) {
  if (!node || typeof node !== 'object') return 'condition vide ou invalide'
  if (depth > 5) return 'imbrication trop profonde (>5 niveaux)'

  // Groupe
  if ('op' in node) {
    if (!VALID_OPS.has(node.op)) return `op invalide: ${node.op}`
    if (!Array.isArray(node.rules) || node.rules.length === 0) return 'un groupe doit contenir au moins une règle'
    for (const r of node.rules) {
      const err = validateConditions(r, depth + 1)
      if (err) return err
    }
    return null
  }

  // Feuille
  if (typeof node.field !== 'string' || !node.field) return 'feuille : field requis'
  if (!VALID_OPERATORS.has(node.operator)) return `operator invalide: ${node.operator}`
  if (node.operator === 'equals' || node.operator === 'not_equals') {
    if (!('value' in node)) return `operator ${node.operator} requiert une value`
  }
  return null
}

// GET /api/field-visibility-rules?context=facture
// Auth requise (montée derrière requireAuth dans index.js), pas admin-only :
// tout user doit pouvoir charger les règles pour évaluer la visibilité.
router.get('/', (req, res) => {
  const { context } = req.query
  const rows = context
    ? db.prepare('SELECT * FROM field_visibility_rules WHERE context=? ORDER BY created_at').all(context)
    : db.prepare('SELECT * FROM field_visibility_rules ORDER BY context, field_id, created_at').all()
  res.json({
    data: rows.map(r => ({
      id: r.id,
      context: r.context,
      field_id: r.field_id,
      conditions: JSON.parse(r.conditions_json),
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  })
})

// POST /api/field-visibility-rules — admin only
router.post('/', requireAdmin, (req, res) => {
  const { context, field_id, conditions } = req.body || {}
  if (!context || typeof context !== 'string') return res.status(400).json({ error: 'context requis' })
  if (!field_id || typeof field_id !== 'string') return res.status(400).json({ error: 'field_id requis' })
  const err = validateConditions(conditions)
  if (err) return res.status(400).json({ error: `conditions invalides : ${err}` })

  const id = newRecordId()
  db.prepare(`
    INSERT INTO field_visibility_rules (id, context, field_id, conditions_json, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, context, field_id, JSON.stringify(conditions), req.user?.id || null)

  const row = db.prepare('SELECT * FROM field_visibility_rules WHERE id=?').get(id)
  res.status(201).json({
    id: row.id,
    context: row.context,
    field_id: row.field_id,
    conditions: JSON.parse(row.conditions_json),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
})

// PUT /api/field-visibility-rules/:id — admin only
router.put('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM field_visibility_rules WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const { conditions } = req.body || {}
  const err = validateConditions(conditions)
  if (err) return res.status(400).json({ error: `conditions invalides : ${err}` })

  db.prepare(`
    UPDATE field_visibility_rules
       SET conditions_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id=?
  `).run(JSON.stringify(conditions), req.params.id)

  const row = db.prepare('SELECT * FROM field_visibility_rules WHERE id=?').get(req.params.id)
  res.json({
    id: row.id,
    context: row.context,
    field_id: row.field_id,
    conditions: JSON.parse(row.conditions_json),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
})

// DELETE /api/field-visibility-rules/:id — admin only
router.delete('/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM field_visibility_rules WHERE id=?').run(req.params.id)
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
})

export default router
