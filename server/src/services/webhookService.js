import crypto from 'crypto'
import db from '../db/database.js'

/**
 * Trigger webhooks for a table event. Fire-and-forget — never blocks the HTTP response.
 */
export function triggerWebhooks(tenantId, tableId, event, payload) {
  // Run asynchronously without awaiting
  _trigger(tenantId, tableId, event, payload).catch(() => {})
}

async function _trigger(tenantId, tableId, event, payload) {
  const webhooks = db.prepare(`
    SELECT * FROM webhooks WHERE table_id = ? AND tenant_id = ? AND active = 1
  `).all(tableId, tenantId)

  for (const webhook of webhooks) {
    let events = []
    try { events = JSON.parse(webhook.events) } catch {}
    if (!events.includes(event)) continue

    const body = JSON.stringify({ event, table_id: tableId, ...payload, timestamp: new Date().toISOString() })
    const headers = { 'Content-Type': 'application/json' }

    if (webhook.secret) {
      headers['X-Webhook-Signature'] = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex')
    }

    _fire(webhook.id, webhook.url, headers, body, 0)
  }
}

async function _fire(webhookId, url, headers, body, retryCount) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    clearTimeout(timeout)

    db.prepare("UPDATE webhooks SET last_triggered_at = datetime('now') WHERE id = ?").run(webhookId)

    if (!response.ok && retryCount === 0) {
      setTimeout(() => _fire(webhookId, url, headers, body, 1), 60000)
    }
  } catch (err) {
    if (retryCount === 0) {
      setTimeout(() => _fire(webhookId, url, headers, body, 1), 60000)
    }
    console.error(`[webhook] ${webhookId} failed:`, err.message)
  }
}
