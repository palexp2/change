import db from '../db/database.js'
import { getAccessToken, airtableDelete } from '../connectors/airtable.js'
import { logSync } from './syncLog.js'

// Une commande qui a un envoi est partie chez le client : on ne la supprime pas.
// Si c'est vraiment une erreur, l'utilisateur délie d'abord ses envois (champ
// « Commande » de la fiche Envoi).
export function linkedShipments(orderId) {
  return db.prepare('SELECT id FROM shipments WHERE order_id = ? AND deleted_at IS NULL').all(orderId)
}

// Supprime la commande dans Boréal (corbeille) ET dans Airtable, articles compris.
// Si Airtable refuse, la commande revient telle quelle dans Boréal et
// l'utilisateur peut réessayer.
export async function deleteOrder(orderId) {
  const order = db.prepare('SELECT id, airtable_id FROM orders WHERE id = ? AND deleted_at IS NULL').get(orderId)
  if (!order) return { status: 404, error: 'Commande introuvable' }
  const shipments = linkedShipments(orderId)
  if (shipments.length) {
    return { status: 409, error: `Commande déjà envoyée : déliez d'abord ${shipments.length > 1 ? `ses ${shipments.length} envois` : 'son envoi'}.`, shipment_ids: shipments.map(s => s.id) }
  }

  // Commande mise à la corbeille et déliée AVANT l'appel, remise en cas
  // d'échec : ni l'avis de suppression renvoyé par Airtable (qui effacerait les
  // lignes pour de bon), ni la reprise System Builder (qui la recréerait) ne
  // doivent la toucher pendant l'appel.
  const items = db.prepare('SELECT id, airtable_id FROM order_items WHERE order_id = ? AND airtable_id IS NOT NULL').all(orderId)
  const itemIds = items.map(r => r.airtable_id)
  const config = db.prepare('SELECT base_id, orders_table_id, items_table_id FROM airtable_orders_config').get()
  if ((order.airtable_id || itemIds.length) && !config?.base_id) return { status: 502, error: 'Configuration Airtable des commandes absente' }
  db.transaction(() => {
    db.prepare('UPDATE order_items SET airtable_id = NULL WHERE order_id = ?').run(orderId)
    db.prepare("UPDATE orders SET airtable_id = NULL, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(orderId)
  })()

  if (order.airtable_id || itemIds.length) {
    const t0 = Date.now()
    try {
      const token = await getAccessToken()
      if (itemIds.length) await airtableDelete(`/${config.base_id}/${config.items_table_id}`, token, itemIds)
      if (order.airtable_id) await airtableDelete(`/${config.base_id}/${config.orders_table_id}`, token, [order.airtable_id])
      logSync('orders', 'erp-writeback', { status: 'success', modified: 1 + itemIds.length, durationMs: Date.now() - t0 })
    } catch (e) {
      restore(order, items)
      logSync('orders', 'erp-writeback', { status: 'error', error: `${orderId}: ${e.message}`, durationMs: Date.now() - t0 })
      return { status: 502, error: `Suppression refusée par Airtable : ${e.message}` }
    }
  }

  // Un formulaire System Builder dont la commande est supprimée peut en recréer une.
  db.prepare('UPDATE customer_onboarding_responses SET generated_order_id = NULL WHERE generated_order_id = ?').run(orderId)
  return { status: 200 }
}

// Échec, même partiel (articles supprimés, pas la commande) : on remet tout ;
// les ids déjà supprimés dans Airtable sont tolérés au prochain essai.
function restore(order, items) {
  db.transaction(() => {
    db.prepare('UPDATE orders SET airtable_id = ?, deleted_at = NULL WHERE id = ?').run(order.airtable_id, order.id)
    const set = db.prepare('UPDATE order_items SET airtable_id = ? WHERE id = ?')
    for (const item of items) set.run(item.airtable_id, item.id)
  })()
}
