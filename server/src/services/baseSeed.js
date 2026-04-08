import db from '../db/database.js'
import { newId } from '../utils/ids.js'

// Legacy tables to register as base_tables metadata stubs
// so the dynamic system can reference them
const LEGACY_TABLES = [
  { name: 'companies',       icon: 'building',     description: 'Entreprises' },
  { name: 'contacts',        icon: 'users',        description: 'Contacts' },
  { name: 'orders',          icon: 'shopping-cart', description: 'Commandes' },
  { name: 'shipments',       icon: 'send',         description: 'Envois' },
  { name: 'products',        icon: 'box',          description: 'Produits' },
  { name: 'purchases',       icon: 'package',      description: 'Achats' },
  { name: 'tickets',         icon: 'help-circle',  description: 'Tickets support' },
  { name: 'interactions',    icon: 'message-circle', description: 'Interactions' },
  { name: 'returns',         icon: 'corner-up-left', description: 'Retours' },
  { name: 'projects',        icon: 'folder',       description: 'Projets' },
]

export function seedBaseTables() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO base_tables (id, name, icon, description, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `)

  let seeded = 0
  db.transaction(() => {
    LEGACY_TABLES.forEach((t, i) => {
      const deterministicId = `tbl_legacy_${t.name}`
      const result = insert.run(deterministicId, t.name, t.icon, t.description, i)
      seeded += result.changes
    })
  })()
  if (seeded > 0) console.log(`[baseSeed] Seeded ${seeded} base_table stub(s)`)
}
