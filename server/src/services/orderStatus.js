// ── Statut d'une commande, calculé par Boréal ───────────────────────────────
//
// Le statut venait de la formule Airtable « Statut » (Commandes), importée en
// lecture seule. Elle est débranchée : Boréal le calcule ici, avec le même
// ordre de décision, mais sur ses propres données (lignes, envois, stock,
// numéros de série) et sans les défauts de la formule :
//   • « Tous les items sont disponibles » sortait dès que RIEN n'était encore
//     envoyé, avant même de regarder la disponibilité — une commande avec une
//     pièce à fabriquer s'affichait « disponible » ;
//   • la disponibilité d'une pièce sérialisée exigeait PLUS de séries que la
//     quantité (`>`), une ligne servie pile à la quantité était « indisponible » ;
//   • logiciel / drop ship / gel comptaient aussi les lignes déjà parties.
//
// Ordre (celui d'Airtable) :
//   1. aucune ligne                               → Commande vide
//   2. toutes les lignes rattachées à un envoi    → Envoyé (aujourd'hui si
//      (ou marquées Envoyé), quel que soit         l'envoi le plus récent
//      le statut ou la date de l'envoi              est daté du jour)
//   3. raison de mise en attente posée            → En attente
//   4. un produit restant en gel d'envois         → Gel d'envois
//   5. ne restent que des logiciels (JWT)         → JWT-config
//   6. ne restent que des drop ship               → Drop ship seulement
//   7. une ligne restante non disponible          → Items à fabriquer ou à acheter
//   8. tout le restant est prélevé / dans l'envoi → Tout est dans la boite
//   9. une partie déjà envoyée                    → Partiellement envoyé
//  10. sinon                                      → Tous les items sont disponibles
import db from '../db/database.js'
import { localDay } from '../utils/datetime.js'
import { emitOrder } from './realtimeEmitters.js'

const TRUTHY = v => v === 1 || v === true || ['1', '1.0', 'true', 'oui'].includes(String(v ?? '').trim().toLowerCase())

// Faits par ligne : la ligne, son produit, et les séries disponibles du produit.
const ITEM_FACTS_SQL = `
  SELECT oi.id, oi.order_id, oi.product_id, COALESCE(oi.qty, 0) AS qty, oi.item_type,
         oi.fulfillment_status, oi.shipment_id, oi.envoi,
         pr.procurement_type, pr.type AS product_type, pr.gel_d_envois,
         pr.besoin_d_un_numero_de_serie, COALESCE(pr.stock_qty, 0) AS stock_qty,
         COALESCE(sc.sale, 0) AS serials_sale, COALESCE(sc.rental, 0) AS serials_rental
  FROM order_items oi
  LEFT JOIN products pr ON pr.id = oi.product_id
  LEFT JOIN (
    SELECT product_id,
           SUM(status = 'Disponible - Vente') AS sale,
           SUM(status = 'Disponible - Location') AS rental
    FROM serial_numbers GROUP BY product_id
  ) sc ON sc.product_id = oi.product_id`

const REC_RE = /rec[a-zA-Z0-9]{14}/g

// Rattache chaque ligne à son envoi : lien Boréal `shipment_id`, sinon les
// records Airtable de la colonne `envoi`. Une ligne rattachée à un envoi compte
// comme envoyée, quels que soient le statut et la date de cet envoi (décision
// P.-A. Papillon, 2026-10-14) — y compris un envoi que Boréal n'a pas (vieux
// envois jamais importés). `shipped_at` = date la plus récente des envois liés
// connus qui en ont une.
function withShipmentFacts(items) {
  const shipments = db.prepare(
    'SELECT id, airtable_id, shipped_at FROM shipments WHERE deleted_at IS NULL'
  ).all()
  const byId = new Map(shipments.map(s => [s.id, s]))
  const byRec = new Map(shipments.filter(s => s.airtable_id).map(s => [s.airtable_id, s]))
  return items.map(i => {
    const linked = i.shipment_id
      ? [byId.get(i.shipment_id)]
      : (String(i.envoi || '').match(REC_RE) || []).map(r => byRec.get(r))
    return {
      ...i,
      has_shipment: linked.length > 0,
      shipped_at: linked.filter(Boolean).map(s => String(s.shipped_at || '').trim()).sort().pop() || '',
    }
  })
}

const isSoftware = i => i.procurement_type === 'Logiciel' || i.product_type === 'JWT'
const isDropShip = i => i.procurement_type === 'Drop ship'
const isShipped = i => i.fulfillment_status === 'Envoyé' || !!i.has_shipment
const isInBox = i => ['Prélevé', "Dans l'envoi"].includes(i.fulfillment_status) || !!i.has_shipment

// Quantité disponible pour la ligne (même règle que « Disponibilité » d'Airtable) :
// pièce sans numéro de série → stock ; sérialisée → séries « Disponible - Vente »,
// plus « Disponible - Location » pour un abonnement ou un remplacement.
export function itemAvailableQty(item, isSubscription) {
  if (!TRUTHY(item.besoin_d_un_numero_de_serie)) return Number(item.stock_qty) || 0
  const rental = isSubscription || item.item_type === 'Remplacement'
  return (item.serials_sale || 0) + (rental ? (item.serials_rental || 0) : 0)
}

// Fonction pure : `order` = { raison_de_la_mise_en_attente, is_subscription },
// `items` = faits par ligne (cf. ITEM_FACTS_SQL), `today` = AAAA-MM-JJ local.
export function computeOrderStatus(order, items, today = localDay()) {
  const lines = items.filter(i => Number(i.qty) !== 0)
  if (!lines.length) return 'Commande vide'

  // Une ligne sans produit encore à envoyer n'est rien à expédier. Les lignes
  // négatives (crédits, retraits) ne s'expédient pas : elles s'annulent avec le
  // restant, comme la somme « À envoyer » d'Airtable.
  const notShipped = lines.filter(i => !isShipped(i) && i.product_id)
  const shipped = lines.filter(i => isShipped(i) && Number(i.qty) > 0)
  const remaining = notShipped.filter(i => Number(i.qty) > 0)
  const netRemaining = notShipped.reduce((sum, i) => sum + Number(i.qty), 0)
  if (!remaining.length || netRemaining <= 0) {
    const last = lines.map(i => String(i.shipped_at || '')).sort().pop() || ''
    const day = last.includes('T') ? localDay(new Date(last)) : last.slice(0, 10)
    return day && day >= today ? "Envoyé aujourd'hui" : 'Envoyé'
  }

  if (String(order.raison_de_la_mise_en_attente ?? '').trim()) return 'En attente'
  if (remaining.some(i => TRUTHY(i.gel_d_envois))) return "Gel d'envois"
  if (remaining.every(isSoftware)) return 'JWT-config'
  if (remaining.every(isDropShip)) return 'Drop ship seulement'

  const physical = remaining.filter(i => !isSoftware(i) && !isDropShip(i))
  const sub = TRUTHY(order.is_subscription)
  const unavailable = physical.filter(i => !isInBox(i) && itemAvailableQty(i, sub) < Number(i.qty))
  if (unavailable.length) return 'Items à fabriquer ou à acheter'
  if (physical.length && physical.every(isInBox)) return 'Tout est dans la boite'
  if (shipped.length) return 'Partiellement envoyé'
  return 'Tous les items sont disponibles'
}

// Recalcule et enregistre le statut des commandes `orderIds` (toutes si null).
// N'écrit et ne notifie que les commandes dont le statut change.
export function refreshOrderStatuses(orderIds = null, { dryRun = false } = {}) {
  const ids = orderIds == null ? null : [...new Set(orderIds)].filter(Boolean)
  if (ids && !ids.length) return { changed: [] }
  const inList = ids ? `IN (${ids.map(() => '?').join(',')})` : ''
  const orders = db.prepare(
    `SELECT id, order_number, status, raison_de_la_mise_en_attente, is_subscription FROM orders
     WHERE deleted_at IS NULL ${ids ? `AND id ${inList}` : ''}`
  ).all(...(ids || []))
  if (!orders.length) return { changed: [] }
  const items = withShipmentFacts(
    db.prepare(`${ITEM_FACTS_SQL} ${ids ? `WHERE oi.order_id ${inList}` : ''}`).all(...(ids || []))
  )
  const byOrder = new Map()
  for (const i of items) {
    if (!byOrder.has(i.order_id)) byOrder.set(i.order_id, [])
    byOrder.get(i.order_id).push(i)
  }
  const today = localDay()
  const update = db.prepare(
    "UPDATE orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  )
  const changed = []
  db.transaction(() => {
    for (const o of orders) {
      const next = computeOrderStatus(o, byOrder.get(o.id) || [], today)
      if (next === o.status) continue
      if (!dryRun) update.run(next, o.id)
      changed.push({ id: o.id, order_number: o.order_number, from: o.status, to: next })
    }
  })()
  if (dryRun) return { changed }
  for (const c of changed) {
    try { emitOrder('updated', c.id, null, { source: 'system', fields: ['status'] }) } catch { /* temps réel best-effort */ }
  }
  return { changed }
}
