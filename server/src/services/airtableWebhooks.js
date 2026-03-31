import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch, airtablePost } from '../connectors/airtable.js'
import { tracked } from './syncState.js'
import {
  syncAirtable, syncInventaire, syncPieces, syncOrders, syncAchats,
  syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours,
  syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges,
  syncAssemblages, syncFactures,
} from './airtable.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
const NOTIFICATION_URL = `${APP_URL}/erp/api/connectors/airtable/webhook-ping`

const SYNC_FNS = {
  airtable: syncAirtable,
  inventaire: syncInventaire,
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

// Build map: airtable tableId → Set of module names (for a given tenant)
function buildTableMap(tenantId) {
  const map = new Map()
  const add = (tableId, module) => {
    if (!tableId) return
    if (!map.has(tableId)) map.set(tableId, new Set())
    map.get(tableId).add(module)
  }

  const crm = db.prepare('SELECT * FROM airtable_sync_config WHERE tenant_id=?').get(tenantId)
  if (crm) {
    add(crm.contacts_table_id, 'airtable')
    add(crm.companies_table_id, 'airtable')
  }

  const inv = db.prepare('SELECT * FROM airtable_inventaire_config WHERE tenant_id=?').get(tenantId)
  if (inv) {
    add(inv.projects_table_id, 'inventaire')
    if (inv.extra_tables) {
      try {
        for (const t of Object.values(JSON.parse(inv.extra_tables))) {
          if (t.table_id) add(t.table_id, 'inventaire')
        }
      } catch {}
    }
  }

  const ord = db.prepare('SELECT * FROM airtable_orders_config WHERE tenant_id=?').get(tenantId)
  if (ord) {
    add(ord.orders_table_id, 'orders')
    add(ord.items_table_id, 'orders')
  }

  const mods = db.prepare('SELECT module, table_id FROM airtable_module_config WHERE tenant_id=?').all(tenantId)
  for (const m of mods) add(m.table_id, m.module)

  return map
}

// Returns all unique base IDs configured for a tenant across all modules
export function getConfiguredBases(tenantId) {
  const bases = new Set()
  const crm = db.prepare('SELECT base_id FROM airtable_sync_config WHERE tenant_id=? AND base_id IS NOT NULL').get(tenantId)
  if (crm) bases.add(crm.base_id)
  const inv = db.prepare('SELECT base_id FROM airtable_inventaire_config WHERE tenant_id=? AND base_id IS NOT NULL').get(tenantId)
  if (inv) bases.add(inv.base_id)
  const ord = db.prepare('SELECT base_id FROM airtable_orders_config WHERE tenant_id=? AND base_id IS NOT NULL').get(tenantId)
  if (ord) bases.add(ord.base_id)
  const mods = db.prepare('SELECT DISTINCT base_id FROM airtable_module_config WHERE tenant_id=? AND base_id IS NOT NULL').all(tenantId)
  for (const m of mods) bases.add(m.base_id)
  return [...bases]
}

// Register a webhook for a base if one doesn't exist yet.
// Safe to call multiple times — returns existing row if already registered.
export async function registerWebhookForBase(tenantId, baseId) {
  const existing = db.prepare('SELECT * FROM airtable_webhooks WHERE tenant_id=? AND base_id=?').get(tenantId, baseId)
  if (existing) return existing

  const token = await getAccessToken(tenantId)
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
    tenant_id: tenantId,
    base_id: baseId,
    webhook_id: data.id,
    cursor: 1,
    mac_secret: data.macSecretBase64 || null,
    expires_at: data.expirationTime || null,
  }
  db.prepare(`
    INSERT OR REPLACE INTO airtable_webhooks (id, tenant_id, base_id, webhook_id, cursor, mac_secret, expires_at)
    VALUES (@id, @tenant_id, @base_id, @webhook_id, @cursor, @mac_secret, @expires_at)
  `).run(row)

  console.log(`✅ Webhook Airtable enregistré: tenant=${tenantId} base=${baseId} webhook=${data.id}`)
  return row
}

// Called when Airtable sends a ping. Fetches payloads, determines which
// modules changed, and triggers the appropriate sync functions.
export async function processWebhookPing(webhookId) {
  const webhook = db.prepare('SELECT * FROM airtable_webhooks WHERE webhook_id=?').get(webhookId)
  if (!webhook) {
    console.warn(`⚠️  Ping reçu pour webhook inconnu: ${webhookId}`)
    return
  }

  const { tenant_id: tenantId, base_id: baseId } = webhook
  let cursor = webhook.cursor

  try {
    const token = await getAccessToken(tenantId)

    // Accumulate changes per tableId across all payloads
    // { tableId: { recordIds: Set, destroyedIds: Set } }
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

    db.prepare('UPDATE airtable_webhooks SET cursor=? WHERE webhook_id=?').run(cursor, webhookId)

    if (tableChanges.size === 0) return

    // Convert Sets to arrays and group by module
    const moduleChanges = new Map() // module → { tableId: { recordIds, destroyedIds } }
    const tableMap = buildTableMap(tenantId)
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
    console.log(`🔔 Webhook Airtable → [${[...moduleChanges.keys()].join(', ')}] +${totalRecords} modifiés, -${totalDestroyed} supprimés (tenant=${tenantId})`)

    for (const [module, changes] of moduleChanges) {
      const fn = SYNC_FNS[module]
      if (!fn) continue
      tracked(tenantId, module, () => fn(tenantId, changes)).catch(e =>
        console.error(`Sync webhook error (${module}):`, e.message)
      )
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
      const token = await getAccessToken(wh.tenant_id)
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

// Called at server startup. Registers missing webhooks for all tenants,
// then schedules daily renewal checks.
export async function initAirtableWebhooks() {
  const tenants = db.prepare('SELECT id FROM tenants').all().map(t => t.id)

  for (const tenantId of tenants) {
    const connected = db.prepare(
      "SELECT id FROM connector_oauth WHERE tenant_id=? AND connector='airtable' LIMIT 1"
    ).get(tenantId)
    if (!connected) continue

    for (const baseId of getConfiguredBases(tenantId)) {
      try {
        await registerWebhookForBase(tenantId, baseId)
      } catch (e) {
        console.error(`❌ Webhook init échoué tenant=${tenantId} base=${baseId}:`, e.message)
      }
    }
  }

  // Renouvellement quotidien
  setInterval(async () => {
    try { await renewExpiringWebhooks() } catch (e) { console.error('Webhook renewal error:', e.message) }
  }, 24 * 60 * 60 * 1000)

  console.log('✅ Airtable webhooks initialisés')
}
