import db from '../db/database.js'

// Champs FK supportés → table cible. Toutes ces tables utilisent un soft-delete
// (`deleted_at`), donc un record supprimé est traité comme inexistant.
const FK_TABLES = {
  company_id: { table: 'companies', label: 'Entreprise' },
  contact_id: { table: 'contacts', label: 'Contact' },
}

// Vérifie l'existence des FK passées avant un INSERT, pour éviter les références
// orphelines (ex. un company_id inventé qui casserait les jointures aval comme
// sendInvoiceEmail). Retourne `{ key, message }` pour la première FK qui ne
// résout pas, sinon `null`. Les valeurs falsy (null/undefined/'') sont ignorées
// — une FK absente est considérée optionnelle, c'est l'appelant qui décide si
// elle est requise.
export function checkForeignKeys(fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    if (!value) continue
    const def = FK_TABLES[key]
    if (!def) continue
    const row = db.prepare(`SELECT id FROM ${def.table} WHERE id = ? AND deleted_at IS NULL`).get(value)
    if (!row) return { key, message: `${def.label} introuvable` }
  }
  return null
}
