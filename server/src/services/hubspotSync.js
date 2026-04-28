import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import {
  isHubSpotConfigured,
  createTask, updateTask, deleteTask, getTask,
  listOwners, searchTasksModifiedSince,
} from '../connectors/hubspot.js'

// ── Field mapping (hardcoded) ────────────────────────────────────────────────

const STATUS_ERP_TO_HS = {
  'À faire':  'NOT_STARTED',
  'En cours': 'IN_PROGRESS',
  'Terminé':  'COMPLETED',
  'Annulé':   'DEFERRED',
}
const STATUS_HS_TO_ERP = {
  NOT_STARTED: 'À faire',
  IN_PROGRESS: 'En cours',
  COMPLETED:   'Terminé',
  DEFERRED:    'Annulé',
  WAITING:     'En cours',
}

const PRIORITY_ERP_TO_HS = {
  Basse:   'LOW',
  Normal:  'MEDIUM',
  Haute:   'HIGH',
  Urgente: 'HIGH',
}
const PRIORITY_HS_TO_ERP = {
  LOW:    'Basse',
  MEDIUM: 'Normal',
  HIGH:   'Haute',
  NONE:   'Normal',
}

// ── Owner cache (ERP user.email → HubSpot owner_id) ──────────────────────────

let ownerCache = { erpEmailToHsId: new Map(), hsIdToErpEmail: new Map(), fetchedAt: 0 }
const OWNER_TTL_MS = 10 * 60 * 1000

async function refreshOwnerCache() {
  const owners = await listOwners()
  const erpEmailToHsId = new Map()
  const hsIdToErpEmail = new Map()
  for (const o of owners) {
    if (o.email && o.id) {
      erpEmailToHsId.set(o.email.toLowerCase(), String(o.id))
      hsIdToErpEmail.set(String(o.id), o.email.toLowerCase())
    }
  }
  ownerCache = { erpEmailToHsId, hsIdToErpEmail, fetchedAt: Date.now() }
  return ownerCache
}

async function getOwnerCache() {
  if (Date.now() - ownerCache.fetchedAt > OWNER_TTL_MS) {
    try { await refreshOwnerCache() } catch (e) { console.error('HubSpot owner cache refresh:', e.message) }
  }
  return ownerCache
}

function erpUserIdToHsOwnerId(userId, cache) {
  if (!userId) return null
  const user = db.prepare('SELECT email, hubspot_owner_id FROM users WHERE id=?').get(userId)
  if (!user) return null
  if (user.hubspot_owner_id) return String(user.hubspot_owner_id)
  if (!user.email) return null
  return cache.erpEmailToHsId.get(user.email.toLowerCase()) || null
}

function hsOwnerIdToErpUserId(hsOwnerId, cache) {
  if (!hsOwnerId) return null
  const hsId = String(hsOwnerId)
  const override = db.prepare('SELECT id FROM users WHERE hubspot_owner_id=?').get(hsId)
  if (override) return override.id
  const email = cache.hsIdToErpEmail.get(hsId)
  if (!email) return null
  const row = db.prepare('SELECT id FROM users WHERE LOWER(email)=?').get(email)
  return row?.id || null
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function erpTaskToHsProperties(task, cache) {
  const props = {
    hs_task_subject:  task.title || '(sans titre)',
    hs_task_body:     task.description || '',
    hs_task_status:   STATUS_ERP_TO_HS[task.status]   || 'NOT_STARTED',
    hs_task_priority: PRIORITY_ERP_TO_HS[task.priority] || 'MEDIUM',
  }
  if (task.due_date) {
    const ts = Date.parse(task.due_date)
    if (!isNaN(ts)) props.hs_timestamp = String(ts)
  } else {
    props.hs_timestamp = String(Date.now())
  }
  const ownerId = erpUserIdToHsOwnerId(task.assigned_to, cache)
  if (ownerId) props.hubspot_owner_id = ownerId
  return props
}

// HubSpot returns timestamps as ISO strings on read but accepts millis on write.
function parseHsDate(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  const ts = Number.isFinite(n) && String(n) === String(v) ? n : Date.parse(v)
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

function hsTaskToErpFields(hs, cache) {
  const p = hs.properties || {}
  return {
    title:       p.hs_task_subject || '(sans titre)',
    description: p.hs_task_body || null,
    status:      STATUS_HS_TO_ERP[p.hs_task_status] || 'À faire',
    priority:    PRIORITY_HS_TO_ERP[p.hs_task_priority] || 'Normal',
    due_date:    parseHsDate(p.hs_timestamp),
    assigned_to: hsOwnerIdToErpUserId(p.hubspot_owner_id, cache),
    last_hubspot_sync: parseHsDate(p.hs_lastmodifieddate) || new Date().toISOString(),
  }
}

// ── Push (ERP → HubSpot) ─────────────────────────────────────────────────────

// Coalesce per-task pushes to avoid bursts when multiple PATCHes fire quickly.
const pendingPushes = new Map() // taskId → Promise

export async function pushTask(taskId) {
  if (!isHubSpotConfigured()) return
  if (pendingPushes.has(taskId)) return pendingPushes.get(taskId)
  const p = (async () => {
    try {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
      if (!task) return
      const cache = await getOwnerCache()

      // Soft-deleted in ERP → archive in HS (if it exists there)
      if (task.deleted_at) {
        if (task.hubspot_task_id) {
          try { await deleteTask(task.hubspot_task_id) } catch (e) {
            if (!/404/.test(e.message)) throw e
          }
        }
        return
      }

      const properties = erpTaskToHsProperties(task, cache)
      if (task.hubspot_task_id) {
        const res = await updateTask(task.hubspot_task_id, properties)
        const ts = res?.properties?.hs_lastmodifieddate || new Date().toISOString()
        db.prepare('UPDATE tasks SET last_hubspot_sync=? WHERE id=?').run(ts, taskId)
      } else {
        const res = await createTask(properties)
        const ts = res?.properties?.hs_lastmodifieddate || new Date().toISOString()
        db.prepare('UPDATE tasks SET hubspot_task_id=?, last_hubspot_sync=? WHERE id=?')
          .run(res.id, ts, taskId)
      }
    } catch (e) {
      console.error(`HubSpot push task ${taskId}:`, e.message)
    } finally {
      pendingPushes.delete(taskId)
    }
  })()
  pendingPushes.set(taskId, p)
  return p
}

export function pushTaskFireAndForget(taskId) {
  pushTask(taskId).catch(e => console.error('HubSpot push:', e.message))
}

// ── Pull (HubSpot → ERP) ─────────────────────────────────────────────────────

function getLastPullCursor() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='hubspot' AND key='last_pull'"
  ).get()
  return row?.value || null
}

function setLastPullCursor(iso) {
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('hubspot','last_pull',?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(iso)
}

/**
 * Pull incremental changes from HubSpot. Also detects deletions by checking
 * whether tasks known to the ERP still exist on HubSpot.
 */
export async function pullDelta({ full = false } = {}) {
  if (!isHubSpotConfigured()) return { modified: 0, destroyed: 0 }
  let modified = 0, destroyed = 0
  const cache = await getOwnerCache()
  const since = full ? null : getLastPullCursor()
  const startedAt = Date.now()
  const results = await searchTasksModifiedSince(since)

  let maxModified = since ? new Date(since).getTime() : 0

  for (const hs of results) {
    const hsModifiedMs = Date.parse(hs.properties?.hs_lastmodifieddate) || Date.now()
    if (hsModifiedMs > maxModified) maxModified = hsModifiedMs
    const hsId = String(hs.id)
    const existing = db.prepare('SELECT * FROM tasks WHERE hubspot_task_id=?').get(hsId)
    const fields = hsTaskToErpFields(hs, cache)

    if (existing) {
      // Echo guard: if ERP last_hubspot_sync >= HS modified, we pushed this change.
      if (existing.last_hubspot_sync) {
        const lastSync = Date.parse(existing.last_hubspot_sync)
        if (!isNaN(lastSync) && lastSync >= hsModifiedMs) continue
      }
      if (existing.deleted_at) {
        db.prepare(`UPDATE tasks SET deleted_at=NULL WHERE id=?`).run(existing.id)
      }
      db.prepare(`
        UPDATE tasks SET title=?, description=?, status=?, priority=?, due_date=?,
          assigned_to=?, last_hubspot_sync=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(
        fields.title, fields.description, fields.status, fields.priority,
        fields.due_date, fields.assigned_to, fields.last_hubspot_sync, existing.id
      )
      modified++
    } else {
      const id = uuidv4()
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, due_date,
          assigned_to, keywords, hubspot_task_id, last_hubspot_sync)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        id, fields.title, fields.description, fields.status, fields.priority,
        fields.due_date, fields.assigned_to, hsId, fields.last_hubspot_sync
      )
      modified++
    }
  }

  // Deletion detection — sample up to 50 ERP tasks not touched in the last 24h
  // and verify they still exist on HubSpot. Keeps the check bounded per run.
  const staleCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const toCheck = db.prepare(`
    SELECT id, hubspot_task_id FROM tasks
    WHERE hubspot_task_id IS NOT NULL AND deleted_at IS NULL
      AND (last_hubspot_sync IS NULL OR last_hubspot_sync < ?)
    LIMIT 50
  `).all(staleCutoff)
  for (const row of toCheck) {
    try {
      const hs = await getTask(row.hubspot_task_id)
      if (!hs) {
        db.prepare("UPDATE tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(row.id)
        destroyed++
      } else {
        db.prepare("UPDATE tasks SET last_hubspot_sync=? WHERE id=?")
          .run(hs.properties?.hs_lastmodifieddate || new Date().toISOString(), row.id)
      }
    } catch (e) {
      console.error(`HubSpot existence check ${row.hubspot_task_id}:`, e.message)
    }
  }

  // After a backfill (or first-ever run with no cursor), anchor the cursor to
  // the run's start time so subsequent deltas only see changes from this point
  // forward — avoids re-pulling the 11k+ historical COMPLETED tasks.
  if (!since) {
    setLastPullCursor(new Date(startedAt).toISOString())
  } else if (maxModified > 0) {
    setLastPullCursor(new Date(maxModified).toISOString())
  }
  return { modified, destroyed }
}

export async function getOwnerMappingStatus() {
  if (!isHubSpotConfigured()) return { configured: false, users: [], owners: [] }
  try {
    const cache = await getOwnerCache()
    const owners = (await listOwners()).map(o => ({
      id: String(o.id),
      email: o.email || null,
      name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || String(o.id),
    })).sort((a, b) => a.name.localeCompare(b.name))

    const users = db.prepare("SELECT id, name, email, hubspot_owner_id FROM users WHERE active=1 ORDER BY name").all()
    return {
      configured: true,
      owners,
      users: users.map(u => {
        const autoId = cache.erpEmailToHsId.get((u.email || '').toLowerCase()) || null
        const overrideId = u.hubspot_owner_id || null
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          auto_owner_id: autoId,
          override_owner_id: overrideId,
          effective_owner_id: overrideId || autoId,
        }
      }),
    }
  } catch (e) {
    return { configured: true, error: e.message, users: [], owners: [] }
  }
}

export function setUserOwnerOverride(userId, hubspotOwnerId) {
  const value = hubspotOwnerId ? String(hubspotOwnerId) : null
  // Enforce uniqueness — clear any other user already pointing at this owner
  if (value) {
    db.prepare('UPDATE users SET hubspot_owner_id=NULL WHERE hubspot_owner_id=? AND id<>?').run(value, userId)
  }
  const r = db.prepare('UPDATE users SET hubspot_owner_id=? WHERE id=?').run(value, userId)
  if (r.changes === 0) throw new Error('Utilisateur introuvable')
  return { ok: true }
}
