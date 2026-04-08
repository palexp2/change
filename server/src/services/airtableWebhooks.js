import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch, airtablePost } from '../connectors/airtable.js'
import { tracked } from './syncState.js'
import { logSync } from './syncLog.js'
import {
  syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats,
  syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours,
  syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges,
  syncAssemblages, syncFactures,
} from './airtable.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const NOTIFICATION_URL = `${APP_URL}/erp/api/connectors/airtable/webhook-ping`

const SYNC_FNS = {
  airtable: syncAirtable,
  projets: syncProjets,
  pieces: syncPieces,
  orders: syncOrders,
  achats: syncAchats,
  billets: syncBillets,
  serials: syncSerials,
  envois: syncEnvois,
  soumissions: syncSoumissions,
  retours: syncRetours,
  retour_items: syncRetourItems,
  adresses: syncAdresses,
  bom: syncBomItems,
  serial_changes: syncSerialStateChanges,
  assemblages: syncAssemblages,
  factures: syncFactures,
}

// Build map: airtable tableId → Set of module names
function buildTableMap() {
  const map = new Map()
  const add = (tableId, module) => {
    if (!tableId) return
    if (!map.has(tableId)) map.set(tableId, new Set())
    map.get(tableId).add(module)
  }

  const crm = db.prepare('SELECT * FROM airtable_sync_config LIMIT 1').get()
  if (crm) {
    add(crm.contacts_table_id, 'airtable')
    add(crm.companies_table_id, 'airtable')
  }

  const inv = db.prepare('SELECT * FROM airtable_projets_config LIMIT 1').get()
  if (inv) {
    add(inv.projects_table_id, 'projets')
    if (inv.extra_tables) {
      try {
        for (const t of Object.values(JSON.parse(inv.extra_tables))) {
          if (t.table_id) add(t.table_id, 'projets')
        }
      } catch {}
    }
  }

  const ord = db.prepare('SELECT * FROM airtable_orders_config LIMIT 1').get()
  if (ord) {
    add(ord.orders_table_id, 'orders')
    add(ord.items_table_id, 'orders')
  }

  const mods = db.prepare('SELECT module, table_id FROM airtable_module_config').all()
  for (const m of mods) add(m.table_id, m.module)

  return map
}

// Returns all unique base IDs configured across all modules
export function getConfiguredBases() {
  const bases = new Set()
  const crm = db.prepare('SELECT base_id FROM airtable_sync_config WHERE base_id IS NOT NULL LIMIT 1').get()
  if (crm) bases.add(crm.base_id)
  const inv = db.prepare('SELECT base_id FROM airtable_projets_config WHERE base_id IS NOT NULL LIMIT 1').get()
  if (inv) bases.add(inv.base_id)
  const ord = db.prepare('SELECT base_id FROM airtable_orders_config WHERE base_id IS NOT NULL LIMIT 1').get()
  if (ord) bases.add(ord.base_id)
  const mods = db.prepare('SELECT DISTINCT base_id FROM airtable_module_config WHERE base_id IS NOT NULL').all()
  for (const m of mods) bases.add(m.base_id)
  return [...bases]
}

// Register a webhook for a base if one doesn't exist yet.
// Safe to call multiple times — returns existing row if already registered.
export async function registerWebhookForBase(baseId) {
  const existing = db.prepare('SELECT * FROM airtable_webhooks WHERE base_id=?').get(baseId)
  if (existing) return existing

  const token = await getAccessToken()
  const data = await airtablePost(`/bases/${baseId}/webhooks`, token, {
    notificationUrl: NOTIFICATION_URL,
    specification: {
      options: {
        filters: {
          dataTypes: ['tableData', 'tableFields'],
        },
      },
    },
  })

  const row = {
    id: uuid(),
    base_id: baseId,
    webhook_id: data.id,
    cursor: 1,
    mac_secret: data.macSecretBase64 || null,
    expires_at: data.expirationTime || null,
  }
  db.prepare(`
    INSERT OR REPLACE INTO airtable_webhooks (id, base_id, webhook_id, cursor, mac_secret, expires_at)
    VALUES (@id, @base_id, @webhook_id, @cursor, @mac_secret, @expires_at)
  `).run(row)

  console.log(`✅ Webhook Airtable enregistré: base=${baseId} webhook=${data.id}`)
  return row
}

// Queue failed changes for retry
function queueRetry(module, changes, error) {
  const id = uuid()
  db.prepare(`
    INSERT INTO webhook_sync_retry (id, module, changes, attempts, last_error, next_retry_at)
    VALUES (?, ?, ?, 1, ?, datetime('now', '+5 minutes'))
  `).run(id, module, JSON.stringify(changes), error)
  console.log(`🔄 ${module}: queued for retry (${error})`)
}

// Process retry queue — called periodically
export async function processRetryQueue() {
  const rows = db.prepare(
    "SELECT * FROM webhook_sync_retry WHERE next_retry_at <= datetime('now') ORDER BY created_at LIMIT 20"
  ).all()
  if (rows.length === 0) return

  console.log(`🔄 Retry queue: ${rows.length} pending`)
  for (const row of rows) {
    const fn = SYNC_FNS[row.module]
    if (!fn) {
      db.prepare('DELETE FROM webhook_sync_retry WHERE id=?').run(row.id)
      continue
    }

    try {
      const changes = JSON.parse(row.changes)
      await tracked(row.module, () => fn(changes))
      db.prepare('DELETE FROM webhook_sync_retry WHERE id=?').run(row.id)
      console.log(`✅ Retry ${row.module}: success`)
    } catch (e) {
      const attempts = row.attempts + 1
      if (attempts >= 5) {
        db.prepare('DELETE FROM webhook_sync_retry WHERE id=?').run(row.id)
        console.error(`❌ Retry ${row.module}: abandoned after ${attempts} attempts (${e.message})`)
      } else {
        // Exponential backoff: 5min, 15min, 45min, 2h
        const delayMinutes = 5 * Math.pow(3, attempts - 1)
        db.prepare(
          "UPDATE webhook_sync_retry SET attempts=?, last_error=?, next_retry_at=datetime('now', ? || ' minutes') WHERE id=?"
        ).run(attempts, e.message, `+${delayMinutes}`, row.id)
        console.warn(`⚠️  Retry ${row.module}: attempt ${attempts} failed, next in ${delayMinutes}min (${e.message})`)
      }
    }
  }
}

// Called when Airtable sends a ping. Fetches payloads, determines which
// modules changed, and triggers the appropriate sync functions.
// On failure, changes are queued for retry instead of being lost.
export async function processWebhookPing(webhookId) {
  const webhook = db.prepare('SELECT * FROM airtable_webhooks WHERE webhook_id=?').get(webhookId)
  if (!webhook) {
    console.warn(`⚠️  Ping reçu pour webhook inconnu: ${webhookId}`)
    return
  }

  const { base_id: baseId } = webhook
  let cursor = webhook.cursor

  try {
    const token = await getAccessToken()

    // Accumulate changes per tableId across all payloads
    const tableChanges = new Map()
    const addChange = (tableId, type, id) => {
      if (!tableChanges.has(tableId)) tableChanges.set(tableId, { recordIds: new Set(), destroyedIds: new Set() })
      tableChanges.get(tableId)[type].add(id)
    }

    let mightHaveMore = true
    while (mightHaveMore) {
      const data = await airtableFetch(
        `/bases/${baseId}/webhooks/${webhookId}/payloads?cursor=${cursor}`,
        token
      )

      for (const payload of data.payloads || []) {
        for (const [tableId, tableData] of Object.entries(payload.changedTablesById || {})) {
          for (const id of Object.keys(tableData.createdRecordsById || {})) addChange(tableId, 'recordIds', id)
          for (const id of Object.keys(tableData.changedRecordsById || {})) addChange(tableId, 'recordIds', id)
          for (const id of (tableData.destroyedRecordIds || [])) addChange(tableId, 'destroyedIds', id)
        }
      }

      cursor = data.cursor ?? cursor
      mightHaveMore = data.mightHaveMore === true
    }

    // Advance cursor immediately — failed syncs go to retry queue
    db.prepare('UPDATE airtable_webhooks SET cursor=? WHERE webhook_id=?').run(cursor, webhookId)

    if (tableChanges.size === 0) return

    // Convert Sets to arrays and group by module
    const moduleChanges = new Map()
    const tableMap = buildTableMap()
    for (const [tableId, { recordIds, destroyedIds }] of tableChanges) {
      const modules = tableMap.get(tableId)
      if (!modules) continue
      const change = { recordIds: [...recordIds], destroyedIds: [...destroyedIds] }
      for (const m of modules) {
        if (!moduleChanges.has(m)) moduleChanges.set(m, {})
        moduleChanges.get(m)[tableId] = change
      }
    }

    if (moduleChanges.size === 0) return

    const totalRecords = [...tableChanges.values()].reduce((s, t) => s + t.recordIds.size, 0)
    const totalDestroyed = [...tableChanges.values()].reduce((s, t) => s + t.destroyedIds.size, 0)
    console.log(`🔔 Webhook Airtable → [${[...moduleChanges.keys()].join(', ')}] +${totalRecords} modifiés, -${totalDestroyed} supprimés`)

    // Await each sync — queue failures for retry, log results
    for (const [module, changes] of moduleChanges) {
      const fn = SYNC_FNS[module]
      if (!fn) continue
      const modifiedCount = Object.values(changes).reduce((s, c) => s + (c.recordIds?.length || 0), 0)
      const destroyedCount = Object.values(changes).reduce((s, c) => s + (c.destroyedIds?.length || 0), 0)
      const t0 = Date.now()
      try {
        await tracked(module, () => fn(changes))
        logSync(module, 'webhook', { status: 'success', modified: modifiedCount, destroyed: destroyedCount, durationMs: Date.now() - t0 })
      } catch (e) {
        console.error(`Sync webhook error (${module}):`, e.message)
        logSync(module, 'webhook', { status: 'error', modified: modifiedCount, destroyed: destroyedCount, error: e.message, durationMs: Date.now() - t0 })
        queueRetry(module, changes, e.message)
      }
    }
  } catch (e) {
    console.error(`❌ Erreur traitement webhook ${webhookId}:`, e.message)
  }
}

// Renew webhooks expiring within 2 days. Called daily.
export async function renewExpiringWebhooks() {
  const cutoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const expiring = db.prepare(
    'SELECT * FROM airtable_webhooks WHERE expires_at IS NOT NULL AND expires_at < ?'
  ).all(cutoff)

  for (const wh of expiring) {
    try {
      const token = await getAccessToken()
      await fetch(`https://api.airtable.com/v0/bases/${wh.base_id}/webhooks/${wh.webhook_id}/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE airtable_webhooks SET expires_at=? WHERE id=?').run(newExpiry, wh.id)
      console.log(`🔄 Webhook renouvelé: ${wh.webhook_id}`)
    } catch (e) {
      console.error(`❌ Échec renouvellement webhook ${wh.webhook_id}:`, e.message)
    }
  }
}

// Called at server startup. Registers missing webhooks,
// then schedules daily renewal checks.
export async function initAirtableWebhooks() {
  const connected = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='airtable' LIMIT 1"
  ).get()
  if (!connected) {
    console.log('✅ Airtable webhooks initialisés (pas de connexion Airtable)')
    return
  }

  for (const baseId of getConfiguredBases()) {
    try {
      await registerWebhookForBase(baseId)
    } catch (e) {
      console.error(`❌ Webhook init échoué base=${baseId}:`, e.message)
    }
  }

  // Renouvellement quotidien
  setInterval(async () => {
    try { await renewExpiringWebhooks() } catch (e) { console.error('Webhook renewal error:', e.message) }
  }, 24 * 60 * 60 * 1000)

  // Retry queue — check every 2 minutes
  setInterval(async () => {
    try { await processRetryQueue() } catch (e) { console.error('Retry queue error:', e.message) }
  }, 2 * 60 * 1000)

  console.log('✅ Airtable webhooks initialisés')
}
