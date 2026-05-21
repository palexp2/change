import db from '../db/database.js'

let stmt
function getStmt() {
  if (!stmt) {
    stmt = db.prepare(`
      SELECT sn.id, sn.address, sn.serial, sn.permissions, pr.name_fr AS product_name
      FROM serial_numbers sn
      LEFT JOIN products pr ON pr.id = sn.product_id
      WHERE sn.company_id = ?
        AND sn.address IS NOT NULL AND sn.address != ''
        AND pr.name_fr LIKE 'Contrôleur central%'
        AND sn.status LIKE 'Opérationnel%'
      ORDER BY COALESCE(sn.updated_at, sn.created_at) DESC
      LIMIT 10
    `)
  }
  return stmt
}

export function getCentralControllers(companyId) {
  if (!companyId) return []
  const rows = getStmt().all(companyId)
  return rows.map(r => {
    if (r.permissions && typeof r.permissions === 'string') {
      try { r.permissions = JSON.parse(r.permissions) }
      catch { r.permissions = null }
    }
    return r
  })
}
