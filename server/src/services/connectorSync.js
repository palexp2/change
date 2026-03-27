import { connectors } from './connectors/index.js'
import { decryptCredentials } from '../utils/encryption.js'
import { newId } from '../utils/ids.js'
import { autoMatchContacts } from './interactionMatcher.js'

const syncIntervals = new Map()

export function initConnectorSync(db) {
  let configs
  try {
    configs = db.prepare(
      'SELECT * FROM base_connector_configs WHERE enabled = 1 AND sync_interval_minutes > 0'
    ).all()
  } catch {
    // Table may not exist yet during first boot before migration
    return
  }
  for (const config of configs) {
    startSync(db, config)
  }
  if (configs.length > 0) {
    console.log(`Connector sync: ${configs.length} connecteur(s) actif(s)`)
  }
}

export function startSync(db, connectorConfig) {
  stopSync(connectorConfig.id)
  const intervalMs = (connectorConfig.sync_interval_minutes || 15) * 60 * 1000

  const intervalId = setInterval(async () => {
    try {
      const connector = connectors[connectorConfig.connector]
      if (!connector) return

      const creds = decryptCredentials(connectorConfig.credentials)
      const config = (() => { try { return JSON.parse(connectorConfig.config || '{}') } catch { return {} } })()
      const credsParsed = (() => { try { return JSON.parse(creds || '{}') } catch { return {} } })()

      const interactions = await connector.pull(
        connectorConfig.tenant_id, config, credsParsed, connectorConfig.last_sync_at
      )

      if (interactions.length > 0) {
        syncInteractions(db, connectorConfig.tenant_id, interactions)
      }

      db.prepare(`
        UPDATE base_connector_configs
        SET last_sync_at = datetime('now'), last_sync_status = 'success', last_sync_error = NULL
        WHERE id = ?
      `).run(connectorConfig.id)
    } catch (err) {
      db.prepare(`
        UPDATE base_connector_configs SET last_sync_status = 'error', last_sync_error = ? WHERE id = ?
      `).run(err.message, connectorConfig.id)
    }
  }, intervalMs)

  syncIntervals.set(connectorConfig.id, intervalId)
}

export function stopSync(configId) {
  if (syncIntervals.has(configId)) {
    clearInterval(syncIntervals.get(configId))
    syncIntervals.delete(configId)
  }
}

export function syncInteractions(db, tenantId, incoming) {
  let created = 0, updated = 0, skipped = 0, linksCreated = 0

  const transaction = db.transaction(() => {
    for (const item of incoming) {
      if (!item.source || !item.external_id) { skipped++; continue }

      const existing = db.prepare(
        'SELECT id FROM base_interactions WHERE source = ? AND external_id = ? AND tenant_id = ?'
      ).get(item.source, item.external_id, tenantId)

      if (existing) {
        db.prepare(`
          UPDATE base_interactions
          SET body = COALESCE(?, body), body_html = COALESCE(?, body_html),
              status = COALESCE(?, status), subject = COALESCE(?, subject),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(item.body, item.body_html, item.status, item.subject, existing.id)
        updated++
      } else {
        const id = newId('int')
        db.prepare(`
          INSERT INTO base_interactions (id, tenant_id, type, direction, subject, body, body_html,
            status, duration_seconds, phone_number, from_address, to_addresses, cc_addresses,
            bcc_addresses, thread_id, message_id, source, external_id, user_id, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tenantId, item.type, item.direction || null, item.subject || null,
          item.body || null, item.body_html || null, item.status || 'completed',
          item.duration_seconds || null, item.phone_number || null, item.from_address || null,
          JSON.stringify(item.to_addresses || []), JSON.stringify(item.cc_addresses || []),
          JSON.stringify(item.bcc_addresses || []), item.thread_id || null,
          item.message_id || null, item.source, item.external_id,
          item.user_id || null, item.completed_at || new Date().toISOString())

        linksCreated += autoMatchContacts(db, tenantId, id, item)
        created++
      }
    }
  })

  transaction()
  return { created, updated, skipped, links_created: linksCreated }
}
