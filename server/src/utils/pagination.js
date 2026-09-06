// Clamp des paramètres de pagination reçus en query/body.
//
// parseLimit borne toujours à [1, max] : une valeur absente ou illisible tombe
// sur `def`, une valeur négative ou nulle remonte à 1 (jamais de LIMIT -5 —
// qui, en SQLite, veut dire « tout »).
export function parseLimit(value, { def, max }) {
  return Math.min(max, Math.max(1, Number(value) || def))
}

export function parseOffset(value) {
  return Math.max(0, Number(value) || 0)
}

// Pagination `?page=&limit=` des listes ; `limit=all` désactive la pagination
// (limitVal -1 = « tout » en SQLite).
export function parsePage(query, def = 50) {
  const { page = 1, limit = def } = query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  return { page, limit, limitAll, limitVal, offset }
}
