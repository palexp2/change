/**
 * 010 — le mapping « Abonnement » des commandes devient explicite.
 *
 * `orders.is_subscription` était alimenté par un mapping IMPLICITE : la clé
 * n'est pas dans `field_map_orders`, et `syncOrders` la redevinait en mémoire à
 * chaque passage (`autoMapField(…, 'abonnement', 'subscription', …)`) sans
 * jamais la persister. C'est exactement ce que le contrat du miroir interdit —
 * un mapping que personne ne voit ni ne peut changer depuis l'app, et qui
 * dépend du nom du champ Airtable du jour.
 *
 * La clé est donc écrite dans le field_map, sur le champ réel (« Abonnement »,
 * un singleSelect Oui/Non). Comportement inchangé : la fonction historique
 * n'auto-détecte que si la clé manque, elle utilisera donc la même valeur.
 *
 * Idempotent : ne touche rien si la clé existe déjà ou si le champ a disparu.
 */
export const id = '010-orders-fieldmap-subscription'
export const description = 'orders : mapping explicite de is_subscription sur le champ « Abonnement »'

export function up(db) {
  const cfg = db.prepare('SELECT rowid, field_map_orders FROM airtable_orders_config LIMIT 1').get()
  if (!cfg?.field_map_orders) return { skipped: 'pas de field_map_orders' }

  let fm
  try { fm = JSON.parse(cfg.field_map_orders) } catch { return { skipped: 'field_map illisible' } }
  if (fm.is_subscription) return { skipped: 'déjà mappé' }

  // Le nom vient du registre, pas d'une constante : c'est lui qui dit ce
  // qu'Airtable expose réellement aujourd'hui.
  const field = db.prepare(`
    SELECT field_name FROM airtable_field_map
     WHERE mirror_id='orders' AND field_name='Abonnement' AND field_id IS NOT NULL
  `).get()
  if (!field) return { skipped: 'champ « Abonnement » introuvable dans le registre' }

  fm.is_subscription = field.field_name
  db.prepare('UPDATE airtable_orders_config SET field_map_orders=? WHERE rowid=?')
    .run(JSON.stringify(fm), cfg.rowid)
  return { mapped: field.field_name }
}
