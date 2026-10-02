/**
 * 104 — Fusion « Capteur de sol » → « Capteur de température du sol ».
 *
 * Deux fiches pour le même produit : « Capteur de sol » (créée dans l'ERP,
 * sans Airtable, seule vendable) et « Capteur de température du sol » (1029,
 * miroir Airtable, porte les commandes, séries et BOM). La seconde est gardée,
 * devient vendable, et reprend les lignes de factures Stripe et les factures
 * en attente de la première, qui passe à la corbeille.
 */

export const id = '104-merge-soil-sensor-products'
export const description = 'Fusion du produit « Capteur de sol » dans « Capteur de température du sol »'

const KEEP = '258b64f7-8762-4891-ae5d-e5c4eb20e7a2'
const DROP = '71c85b02-ae26-4cf2-b3c0-709ac29e27a9'

export function up(db) {
  const get = db.prepare('SELECT id FROM products WHERE id=? AND deleted_at IS NULL')
  if (!get.get(KEEP) || !get.get(DROP)) return

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
  for (const t of tables) {
    const cols = db.pragma(`table_info("${t}")`).map(c => c.name)
    if (t !== 'products' && cols.includes('product_id')) {
      db.prepare(`UPDATE OR IGNORE "${t}" SET product_id=? WHERE product_id=?`).run(KEEP, DROP)
    }
  }
  // En JS : replace() SQLite est masqué par l'UDF REPLACE des formules.
  const upd = db.prepare('UPDATE pending_invoices SET items_json=? WHERE id=?')
  for (const r of db.prepare('SELECT id, items_json FROM pending_invoices WHERE instr(items_json, ?) > 0').all(DROP)) {
    upd.run(r.items_json.split(DROP).join(KEEP), r.id)
  }

  db.prepare("UPDATE products SET is_sellable=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(KEEP)
  db.prepare("UPDATE products SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), active=0 WHERE id=?").run(DROP)
}
