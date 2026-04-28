import db from '../db/database.js'

const stmt = db.prepare(`
  SELECT sn.address, sn.serial, pr.name_fr AS product_name
  FROM serial_numbers sn
  LEFT JOIN products pr ON pr.id = sn.product_id
  WHERE sn.company_id = ?
    AND sn.address IS NOT NULL AND sn.address != ''
    AND pr.name_fr LIKE 'Contrôleur central%'
    AND sn.status LIKE 'Opérationnel%'
  ORDER BY COALESCE(sn.updated_at, sn.created_at) DESC
  LIMIT 10
`)

export function getCentralControllers(companyId) {
  if (!companyId) return []
  return stmt.all(companyId)
}
