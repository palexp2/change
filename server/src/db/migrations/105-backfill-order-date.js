/**
 * 105 — « Date de la commande » des commandes nées dans l'ERP.
 *
 * Champ miroir Airtable affiché sur la fiche : une commande créée dans l'ERP
 * restait vide (« — ») tant qu'Airtable ne l'avait pas renvoyé. Comble avec la
 * date de création (jour local), comme le fait désormais POST /api/orders.
 */

import { localDay } from '../../utils/datetime.js'

export const id = '105-backfill-order-date'
export const description = 'Date de la commande = date de création pour les commandes sans date'

export function up(db) {
  if (!db.pragma('table_info(orders)').some(c => c.name === 'date_de_la_commande')) return
  const upd = db.prepare('UPDATE orders SET date_de_la_commande=? WHERE id=? AND date_de_la_commande IS NULL')
  for (const r of db.prepare('SELECT id, date_commande, created_at FROM orders WHERE date_de_la_commande IS NULL AND deleted_at IS NULL AND created_at IS NOT NULL').all()) {
    const day = r.date_commande ? String(r.date_commande).slice(0, 10) : localDay(new Date(r.created_at))
    upd.run(`${day}T00:00:00.000Z`, r.id)
  }
}
