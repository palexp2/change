/**
 * 144 — Règles de visibilité des champs : sens inversé.
 *
 * Demande de Charles (2026-10-16) : une règle dit désormais quand MONTRER le
 * champ (avant : quand le masquer). Pour que les fiches restent identiques,
 * chaque règle existante est remplacée par sa négation (De Morgan). Plusieurs
 * règles d'un même champ (avant : masqué si l'une est vraie) deviennent une
 * seule règle ET de leurs négations.
 */
export const id = '144-field-visibility-show-when'
export const description = 'Visibilité des champs : les règles disent quand montrer (négation des règles existantes)'

const NEG_OP = { AND: 'OR', OR: 'AND' }
const NEG_OPERATOR = { populated: 'empty', empty: 'populated', equals: 'not_equals', not_equals: 'equals' }

function negate(node) {
  if ('op' in node) return { op: NEG_OP[node.op], rules: node.rules.map(negate) }
  return { ...node, operator: NEG_OPERATOR[node.operator] }
}

export function up(db) {
  const rows = db.prepare(`SELECT id, context, field_id, conditions_json FROM field_visibility_rules ORDER BY created_at`).all()
  const byField = new Map()
  for (const r of rows) {
    const k = `${r.context}\u0000${r.field_id}`
    if (!byField.has(k)) byField.set(k, [])
    byField.get(k).push(r)
  }
  const upd = db.prepare(`UPDATE field_visibility_rules SET conditions_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
  const del = db.prepare(`DELETE FROM field_visibility_rules WHERE id = ?`)
  for (const group of byField.values()) {
    const negs = group.map(r => negate(JSON.parse(r.conditions_json)))
    const merged = negs.length === 1 ? negs[0] : { op: 'AND', rules: negs }
    upd.run(JSON.stringify(merged), group[0].id)
    for (const r of group.slice(1)) del.run(r.id)
  }
}
