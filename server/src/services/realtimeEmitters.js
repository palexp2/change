// Single source of truth for the realtime payloads of the pilot entities
// (orders, companies). The shape returned here MUST match what the
// corresponding list page / detail page consumes — keep in sync with the
// SELECTs in routes/orders.js GET / and routes/companies.js GET /.
//
// Called from:
//   - HTTP routes after a mutation (req.user.id available)
//   - External syncs: services/airtable.js, services/quickbooks.js,
//     services/stripe.js, services/installationFollowup.js (no actor)

import db from '../db/database.js'
import { emit } from './realtime.js'
import { logActivity, deriveActivityLabel } from './activityLog.js'

function buildOrderListRow(id) {
  return db.prepare(
    `SELECT o.*, c.name as company_name, u.name as assigned_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as items_count,
      (SELECT SUM(oi.qty * oi.unit_cost) FROM order_items oi WHERE oi.order_id = o.id) as total_value
     FROM orders o
     LEFT JOIN companies c ON o.company_id = c.id
     LEFT JOIN users u ON o.assigned_to = u.id
     WHERE o.id = ?`
  ).get(id)
}

function buildCompanyListRow(id) {
  return db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) as contacts_count,
      (SELECT COUNT(*) FROM projects p WHERE p.company_id = c.id) as projects_count,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) as orders_count
     FROM companies c WHERE c.id = ?`
  ).get(id)
}

export function emitOrder(verb, id, actorUserId = null) {
  const payload = verb === 'deleted' ? { id } : buildOrderListRow(id)
  if (!payload) return
  emit(['orders:list', `order:${id}`], {
    type: `order:${verb}`,
    payload,
    actorUserId,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: 'order', entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}

export function emitOrderItem(verb, orderId, payload, actorUserId = null) {
  emit([`order:${orderId}`], {
    type: `order:item:${verb}`,
    payload,
    actorUserId,
    ts: Date.now(),
  })
}

export function emitCompany(verb, id, actorUserId = null) {
  const payload = verb === 'deleted' ? { id } : buildCompanyListRow(id)
  if (!payload) return
  emit(['companies:list', `company:${id}`], {
    type: `company:${verb}`,
    payload,
    actorUserId,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: 'company', entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}

/**
 * Notifie qu'un des sous-tableaux d'une fiche entreprise a changé (ex. liste
 * des contacts liés via contact_companies). Charge utile minimale — le client
 * choisit de re-fetcher s'il a la fiche ouverte. Plusieurs `companyIds`
 * peuvent être passés (un PATCH de principale touche deux entreprises).
 */
export function emitCompanyContactsChanged(companyIds, actorUserId = null) {
  const ids = (Array.isArray(companyIds) ? companyIds : [companyIds]).filter(Boolean)
  if (!ids.length) return
  for (const id of ids) {
    emit([`company:${id}`], {
      type: 'company:contacts_changed',
      payload: { id },
      actorUserId,
      ts: Date.now(),
    })
  }
}

/**
 * Generic emitter for any entity. The route is responsible for shaping the
 * payload (typically a SELECT with the same JOINs as the GET /api/<entity>
 * list endpoint, so the client can splice it into table state without
 * re-querying).
 *
 * Channels: emits on `${entity}:list` AND `${entity}:${id}` so both the list
 * page and the detail page receive the event with one call. The wire message
 * is tagged with whichever channel matched first per socket.
 *
 * For deletes, pass payload = { id } (or whatever minimal shape lets the
 * client filter the row out).
 *
 * For sub-resource events (e.g. an item inside an order), prefer a dedicated
 * helper or call `emit([\`${parent}:${parentId}\`], ...)` directly — this
 * helper assumes 1:1 (entity, id).
 */
export function emitEntity(entity, verb, id, payload, actorUserId = null) {
  if (!entity || !verb || !id) return
  if (!payload) return
  emit([`${entity}:list`, `${entity}:${id}`], {
    type: `${entity}:${verb}`,
    payload,
    actorUserId,
    ts: Date.now(),
  })
  if (actorUserId) logActivity({ userId: actorUserId, entityType: entity, entityId: id, action: verb, detail: deriveActivityLabel(payload) })
}
