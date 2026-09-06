// Centre de notifications in-app.
//
// La table `notifications` (schema.js) reçoit une ligne par évènement destiné
// à un utilisateur précis (assignation, mention, exécution d'automation…). Ce
// service est le SEUL point d'écriture : il insère puis pousse l'évènement en
// temps réel sur le canal privé de l'utilisateur, que la cloche (NotificationBell)
// écoute. Les routes/services appellent `createNotification` ou le helper
// `notifyAssignment` ; ils ne touchent jamais la table directement.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { emit } from './realtime.js'

/** Canal temps réel privé d'un utilisateur. Le client s'y abonne avec son propre id. */
export function notificationChannel(userId) {
  return `notifications:user:${userId}`
}

/**
 * Crée une notification in-app et la pousse en temps réel.
 *
 * No-op (retourne null) si :
 *   - `userId`, `type` ou `title` manquent ;
 *   - l'acteur se notifie lui-même (`actorUserId === userId`) — convention
 *     GitHub/Linear : on ne notifie pas quelqu'un de sa propre action.
 *
 * @returns la ligne créée, ou null.
 */
export function createNotification({ userId, type, title, body = null, link = null, actorUserId = null }) {
  if (!userId || !type || !title) return null
  if (actorUserId && actorUserId === userId) return null

  const id = newRecordId()
  db.prepare(
    `INSERT INTO notifications (id, user_id, type, title, body, link, read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).run(id, userId, type, title, body, link)
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)

  // L'émission temps réel ne doit jamais faire échouer la mutation appelante.
  try {
    emit([notificationChannel(userId)], {
      type: 'notification:created',
      payload: row,
      actorUserId,
      ts: Date.now(),
    })
  } catch {}

  return row
}

/**
 * Notifie une (ré)assignation. À appeler depuis les routes create/update des
 * entités qui portent un `assigned_to` (orders, tasks, tickets…).
 *
 * No-op si pas d'assigné, ou si l'assigné ne change pas (`prevAssignedTo`
 * fourni et identique) — évite de re-notifier sur un PATCH qui ne touche pas
 * le champ assignation. La règle « pas d'auto-notification » est appliquée par
 * `createNotification`.
 */
export function notifyAssignment({ assignedTo, prevAssignedTo, actorUserId, type, title, body = null, link = null }) {
  if (!assignedTo) return null
  if (prevAssignedTo !== undefined && prevAssignedTo === assignedTo) return null
  return createNotification({ userId: assignedTo, type, title, body, link, actorUserId })
}
