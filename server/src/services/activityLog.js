// Journal d'activité applicatif (qui / quoi / quand).
//
// Pourquoi : change_log capture toutes les mutations des tables cachées mais
// sans l'utilisateur et avec une rétention de 48h (il sert le cache client).
// activity_log est persistant et axé sur l'attribution : il répond à « qui a
// fait quoi, et quand » et alimente la page « Feed des opérations ».
//
// Écriture : au niveau route, via le point de passage central des mutations
// (emitEntity / emitOrder / emitCompany dans realtimeEmitters.js). On ne loggue
// que lorsqu'un acteur humain est connu (actorUserId) — les syncs externes
// (Airtable, Stripe, Gmail…) passent un acteur null et sont donc ignorées,
// puisque le feed concerne les opérations utilisateur.

import db from '../db/database.js'

export function logActivity({ userId, entityType, entityId, action, detail = null }) {
  if (!entityType || !action) return
  try {
    db.prepare(
      `INSERT INTO activity_log (user_id, entity_type, entity_id, action, detail)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      userId || null,
      String(entityType),
      entityId == null ? null : String(entityId),
      String(action),
      detail == null ? null : String(detail).slice(0, 300)
    )
  } catch (e) {
    // Le logging d'activité ne doit jamais casser une mutation métier.
    console.error('logActivity failed:', e.message)
  }
}

// Champs préférés (dans l'ordre) pour produire un libellé lisible à partir du
// payload realtime d'une entité — sert de "detail" humain dans le feed.
const LABEL_KEYS = [
  'name', 'company_name', 'company', 'title', 'subject', 'receipt_number',
  'number', 'order_number', 'reference', 'original_name', 'email',
]

export function deriveActivityLabel(payload) {
  if (!payload || typeof payload !== 'object') return null
  for (const k of LABEL_KEYS) {
    if (payload[k]) return String(payload[k]).slice(0, 200)
  }
  return null
}
