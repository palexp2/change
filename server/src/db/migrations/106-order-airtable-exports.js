/**
 * 106 — Commandes créées dans l'ERP à transmettre à Airtable.
 *
 * Seules les commandes System Builder partaient vers Airtable ; une commande
 * créée à la main dans l'ERP n'y apparaissait jamais. Cette table marque les
 * commandes nées dans l'ERP : la reprise périodique y envoie la commande puis
 * ses articles (y compris ceux ajoutés après coup). Amorcée avec les commandes
 * actives encore sans jumeau Airtable.
 */

export const id = '106-order-airtable-exports'
export const description = 'Commandes ERP à transmettre à Airtable'

export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_airtable_exports (
    order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
  db.exec(`INSERT OR IGNORE INTO order_airtable_exports (order_id)
           SELECT id FROM orders WHERE airtable_id IS NULL AND deleted_at IS NULL`)
}
