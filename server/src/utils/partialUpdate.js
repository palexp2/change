// Build a partial SQL UPDATE from an HTTP body. Only columns present in the
// body (by key, not by truthiness) are touched — absent keys are left intact.
// This prevents autosave patches from silently wiping columns whose values the
// client didn't send.
//
// Usage :
//   const { setClause, values, error } = buildPartialUpdate(req.body, {
//     allowed: ['first_name', 'last_name', 'email', 'company_id'],
//     nonNullable: new Set(['first_name', 'last_name']),
//     coerce: { is_sellable: v => v ? 1 : 0 },
//   })
//   if (error) return res.status(400).json({ error })
//   if (setClause) db.prepare(`UPDATE contacts SET ${setClause} WHERE id = ?`)
//     .run(...values, id)
//
// `allowed` — whitelist of accepted columns.
// `nonNullable` — columns where null / undefined / '' is rejected (400).
// `coerce` — per-column transform applied before the null check.
// Default coercion : '' and undefined become null, everything else passes through.

// Coercions réutilisables pour les registres de schéma (voir db/recordRegistry.js
// et routes/records.js). Centralisées ici pour que l'API générique et les routes
// hand-rollées partagent exactement la même sémantique de conversion.
//
// toBool            — n'importe quelle valeur truthy → 1, sinon 0 (défaut 0).
// toBoolDefaultTrue — défaut 1 : seul un faux explicite (0/false/'0') donne 0.
// trimOrNull        — chaîne trimmée, ou null si vide (utile avec nonNullable).
export const toBool = (v) => (v ? 1 : 0)
export const toBoolDefaultTrue = (v) => (v === 0 || v === false || v === '0' ? 0 : 1)
export const trimOrNull = (v) => {
  const t = v == null ? '' : String(v).trim()
  return t || null
}

export function buildPartialUpdate(body, { allowed, coerce = {}, nonNullable = new Set() } = {}) {
  const updates = {}
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    let v = body[key]
    if (coerce[key]) v = coerce[key](v)
    else if (v === '' || v === undefined) v = null
    if (nonNullable.has(key) && (v === null || v === undefined)) {
      return { error: `${key} cannot be empty` }
    }
    updates[key] = v
  }
  const cols = Object.keys(updates)
  if (cols.length === 0) return { setClause: '', values: [], cols: [] }
  return {
    setClause: cols.map(c => `${c} = ?`).join(', '),
    values: cols.map(c => updates[c]),
    cols,
  }
}
