import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getAccessToken, airtableFetch, airtablePost } from '../connectors/airtable.js'
import { tracked } from './syncState.js'
import { logSync } from './syncLog.js'
import { logSystemRun } from './systemAutomations.js'
import {
  syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats,
  syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours,
  syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges,
  syncAssemblages, syncStockMovements,
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
  stock_movements: syncStockMovements,
}

// Per-module local tables used to snapshot records before/after sync for diff display.
// Only modules whose records map to a UI-addressable entity are listed.
const MODULE_DIFF_TARGETS = {
  billets:  [{ table: 'tickets',   path: 'tickets',   label: 'Billet' }],
  envois:   [{ table: 'shipments', path: 'envois',    label: 'Envoi' }],
  airtable: [
    { table: 'contacts',  path: 'contacts',  label: 'Contact' },
    { table: 'companies', path: 'companies', label: 'Entreprise' },
  ],
}

const DIFF_SKIP_FIELDS = new Set(['updated_at', 'created_at', 'last_hubspot_uptade'])

function snapshotModule(module, airtableIds) {
  const targets = MODULE_DIFF_TARGETS[module]
  if (!targets || !airtableIds.length) return new Map()
  const snap = new Map()
  const placeholders = airtableIds.map(() => '?').join(',')
  for (const t of targets) {
    try {
      const rows = db.prepare(
        `SELECT * FROM ${t.table} WHERE airtable_id IN (${placeholders})`
      ).all(...airtableIds)
      for (const row of rows) snap.set(row.airtable_id, { target: t, row })
    } catch {}
  }
  return snap
}

function diffRows(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  const changed = []
  for (const k of keys) {
    if (DIFF_SKIP_FIELDS.has(k)) continue
    const bv = before?.[k]
    const av = after?.[k]
    if (bv === av) continue
    if (bv == null && av == null) continue
    changed.push({ field: k, before: bv, after: av })
  }
  return changed
}

function fmtDiffValue(v) {
  if (v == null || v === '') return '∅'
  const s = typeof v === 'string' ? v : String(v)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

function recordLabel(row) {
  return row?.title || row?.name || row?.document_number || row?.order_number || row?.airtable_id || '?'
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
    VALUES (?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes'))
  `).run(id, module, JSON.stringify(changes), error)
  console.log(`🔄 ${module}: queued for retry (${error})`)
}

// Process retry queue — called periodically
export async function processRetryQueue() {
  const rows = db.prepare(
    "SELECT * FROM webhook_sync_retry WHERE next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY created_at LIMIT 20"
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
          "UPDATE webhook_sync_retry SET attempts=?, last_error=?, next_retry_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' minutes') WHERE id=?"
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
  const started = Date.now()
  const webhook = db.prepare('SELECT * FROM airtable_webhooks WHERE webhook_id=?').get(webhookId)
  if (!webhook) {
    console.warn(`⚠️  Ping reçu pour webhook inconnu: ${webhookId}`)
    logSystemRun('sys_airtable_webhook_router', {
      status: 'error',
      error: `Ping reçu pour webhook inconnu: ${webhookId}`,
      duration_ms: Date.now() - started,
    })
    return
  }

  const { base_id: baseId } = webhook
  let cursor = webhook.cursor

  try {
    const token = await getAccessToken()

    // Accumulate changes per tableId across all payloads
    const tableChanges = new Map()
    const tableEntry = (tableId) => {
      if (!tableChanges.has(tableId)) {
        tableChanges.set(tableId, {
          recordIds: new Set(),
          destroyedIds: new Set(),
          changedFieldIds: new Set(),
          hasCreates: false,
        })
      }
      return tableChanges.get(tableId)
    }

    let mightHaveMore = true
    while (mightHaveMore) {
      const data = await airtableFetch(
        `/bases/${baseId}/webhooks/${webhookId}/payloads?cursor=${cursor}`,
        token
      )

      for (const payload of data.payloads || []) {
        for (const [tableId, tableData] of Object.entries(payload.changedTablesById || {})) {
          const entry = tableEntry(tableId)
          for (const [id, rec] of Object.entries(tableData.createdRecordsById || {})) {
            entry.recordIds.add(id)
            entry.hasCreates = true
            const cells = rec?.cellValuesByFieldId || {}
            for (const fid of Object.keys(cells)) entry.changedFieldIds.add(fid)
          }
          for (const [id, rec] of Object.entries(tableData.changedRecordsById || {})) {
            entry.recordIds.add(id)
            const cells = rec?.current?.cellValuesByFieldId || {}
            for (const fid of Object.keys(cells)) entry.changedFieldIds.add(fid)
          }
          for (const id of (tableData.destroyedRecordIds || [])) entry.destroyedIds.add(id)
        }
      }

      cursor = data.cursor ?? cursor
      mightHaveMore = data.mightHaveMore === true
    }

    // Advance cursor immediately — failed syncs go to retry queue
    db.prepare('UPDATE airtable_webhooks SET cursor=? WHERE webhook_id=?').run(cursor, webhookId)

    if (tableChanges.size === 0) {
      logSystemRun('sys_airtable_webhook_router', {
        status: 'skipped',
        result: 'Ping reçu, aucun changement de table à dispatcher.',
        duration_ms: Date.now() - started,
        triggerData: { webhookId, baseId },
      })
      return
    }

    // Convert Sets to arrays and group by module
    const moduleChanges = new Map()
    const tableMap = buildTableMap()
    for (const [tableId, { recordIds, destroyedIds, changedFieldIds, hasCreates }] of tableChanges) {
      const modules = tableMap.get(tableId)
      if (!modules) continue
      const change = {
        recordIds: [...recordIds],
        destroyedIds: [...destroyedIds],
        changedFieldIds: [...changedFieldIds],
        hasCreates,
      }
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
    const moduleResults = []
    for (const [module, changes] of moduleChanges) {
      const fn = SYNC_FNS[module]
      if (!fn) continue
      const modifiedCount = Object.values(changes).reduce((s, c) => s + (c.recordIds?.length || 0), 0)
      const destroyedCount = Object.values(changes).reduce((s, c) => s + (c.destroyedIds?.length || 0), 0)
      const allRecordIds = [...new Set(Object.values(changes).flatMap(c => c.recordIds || []))]
      const before = snapshotModule(module, allRecordIds)
      const t0 = Date.now()
      try {
        await tracked(module, () => fn(changes))
        const after = snapshotModule(module, allRecordIds)
        const diffs = []
        for (const id of allRecordIds) {
          const b = before.get(id)
          const a = after.get(id)
          const target = a?.target || b?.target
          if (!target) continue
          const row = a?.row || b?.row
          const changed = diffRows(b?.row, a?.row)
          const action = !b && a ? 'créé' : (!a && b ? 'supprimé' : 'modifié')
          if (action === 'modifié' && changed.length === 0) continue
          diffs.push({ target, action, localId: row?.id, label: recordLabel(row), changes: changed })
        }
        logSync(module, 'webhook', { status: 'success', modified: modifiedCount, destroyed: destroyedCount, durationMs: Date.now() - t0 })
        moduleResults.push({ module, ok: true, modified: modifiedCount, destroyed: destroyedCount, diffs })
      } catch (e) {
        console.error(`Sync webhook error (${module}):`, e.message)
        logSync(module, 'webhook', { status: 'error', modified: modifiedCount, destroyed: destroyedCount, error: e.message, durationMs: Date.now() - t0 })
        queueRetry(module, changes, e.message)
        moduleResults.push({ module, ok: false, modified: modifiedCount, destroyed: destroyedCount, error: e.message, diffs: [] })
      }
    }

    const failed = moduleResults.filter(r => !r.ok)
    const lines = [`${moduleResults.length} module(s) dispatché(s)`]
    for (const r of moduleResults) {
      lines.push(`  • ${r.module} : ${r.ok ? 'OK' : 'ERR'} — ${r.modified} modifiés, ${r.destroyed} supprimés${r.error ? ' — ' + r.error : ''}`)
      const shown = (r.diffs || []).slice(0, 20)
      for (const d of shown) {
        lines.push('')
        lines.push(`    ${d.label} (${d.action})`)
        if (d.localId) lines.push(`    ${APP_URL}/erp/${d.target.path}/${d.localId}`)
        for (const c of d.changes) {
          lines.push(`    - ${c.field}: ${fmtDiffValue(c.before)}`)
          lines.push(`    + ${c.field}: ${fmtDiffValue(c.after)}`)
        }
      }
      if ((r.diffs?.length || 0) > shown.length) {
        lines.push(`    … et ${r.diffs.length - shown.length} autre(s) record(s)`)
      }
    }

    logSystemRun('sys_airtable_webhook_router', {
      status: failed.length > 0 ? 'error' : 'success',
      result: lines.join('\n'),
      error: failed.length > 0 ? `${failed.length} module(s) en échec (retry queue)` : null,
      duration_ms: Date.now() - started,
      triggerData: { webhookId, baseId, modules: [...moduleChanges.keys()] },
    })
  } catch (e) {
    console.error(`❌ Erreur traitement webhook ${webhookId}:`, e.message)
    logSystemRun('sys_airtable_webhook_router', {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
      triggerData: { webhookId, baseId },
    })
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
