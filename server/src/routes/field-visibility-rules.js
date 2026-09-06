import { requireAdmin } from '../middleware/auth.js'
import { crudRouter, patchRow } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'

const VALID_OPS = new Set(['AND', 'OR'])
const VALID_OPERATORS = new Set(['populated', 'empty', 'equals', 'not_equals'])

// Arbre de conditions : { op: 'AND'|'OR', rules: [ leaf | group ] },
// leaf = { field, operator, value? }.
function validateConditions(node, depth = 0) {
  if (!node || typeof node !== 'object') return 'condition vide ou invalide'
  if (depth > 5) return 'imbrication trop profonde (>5 niveaux)'
  if ('op' in node) {
    if (!VALID_OPS.has(node.op)) return `op invalide: ${node.op}`
    if (!Array.isArray(node.rules) || node.rules.length === 0) return 'un groupe doit contenir au moins une règle'
    for (const r of node.rules) {
      const err = validateConditions(r, depth + 1)
      if (err) return err
    }
    return null
  }
  if (typeof node.field !== 'string' || !node.field) return 'feuille : field requis'
  if (!VALID_OPERATORS.has(node.operator)) return `operator invalide: ${node.operator}`
  if ((node.operator === 'equals' || node.operator === 'not_equals') && !('value' in node)) {
    return `operator ${node.operator} requiert une value`
  }
  return null
}

const spec = {
  ...RECORD_REGISTRY.field_visibility_rules,
  beforeCreate(body, req) {
    const { context, field_id, conditions } = body
    if (!context || typeof context !== 'string') return 'context requis'
    if (!field_id || typeof field_id !== 'string') return 'field_id requis'
    const err = validateConditions(conditions)
    if (err) return `conditions invalides : ${err}`
    body.conditions_json = JSON.stringify(conditions)
    body.created_by = req.user?.id || null
  },
}

export default crudRouter(spec, {
  omit: ['update'],
  extend(router) {
    router.put('/:id', requireAdmin, (req, res) => {
      const { conditions } = req.body || {}
      const err = validateConditions(conditions)
      if (err) return res.status(400).json({ error: `conditions invalides : ${err}` })
      const r = patchRow(spec, req.params.id, { conditions_json: JSON.stringify(conditions) }, req)
      res.status(r.status).json(r.json)
    })
  },
})
