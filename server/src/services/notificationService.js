import db from '../db/database.js'
import { newId } from '../utils/ids.js'
import { broadcast } from './realtime.js'

/**
 * Creates a notification and broadcasts it via WebSocket.
 * @param {string} tenantId
 * @param {string} userId - Recipient user ID
 * @param {{ type, title, body?, link? }} notification
 * @returns {string} New notification ID
 */
export function createNotification(tenantId, userId, notification) {
  const id = newId('notif')
  db.prepare(`
    INSERT INTO notifications (id, tenant_id, user_id, type, title, body, link)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, userId, notification.type, notification.title,
    notification.body || null, notification.link || null)

  broadcast(tenantId, {
    type: 'notification',
    userId,
    notification: { id, ...notification, read: 0, created_at: new Date().toISOString() }
  })

  return id
}
