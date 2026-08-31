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

// ── Push failure persistence & retry ─────────────────────────────────────────
//
// pushTaskFireAndForget() ne bloque pas l'utilisateur, mais avant cette file un
// échec de push était simplement loggé puis oublié : l'ERP croyait la tâche
// synchronisée alors qu'elle divergeait silencieusement de HubSpot. On persiste
// désormais chaque échec dans `hubspot_push_failures` et un worker les rejoue.

// Backoff exponentiel borné. `attempts` est le compteur APRÈS l'échec courant
// (1 = premier échec). 1er retry ≈ 1 min, plafonné à 1 h pour rester observable
// et finir par réussir quand HubSpot se rétablit, sans marteler l'API.
const PUSH_RETRY_BASE_MS = 60 * 1000
const PUSH_RETRY_MAX_MS = 60 * 60 * 1000
export function computePushRetryDelayMs(attempts) {
  const n = Math.max(1, attempts)
  return Math.min(PUSH_RETRY_BASE_MS * 2 ** (n - 1), PUSH_RETRY_MAX_MS)
}

// Enregistre/incrémente un échec de push. `first_failed_at` n'est jamais écrasé
// (omis du DO UPDATE) afin de conserver l'ancienneté réelle de la divergence.
export function recordPushFailure(taskId, errorMessage, conn = db) {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const prev = conn.prepare('SELECT attempts FROM hubspot_push_failures WHERE task_id=?').get(taskId)
  const attempts = (prev?.attempts || 0) + 1
  const nextRetry = new Date(now + computePushRetryDelayMs(attempts)).toISOString()
  conn.prepare(`
    INSERT INTO hubspot_push_failures
      (task_id, attempts, last_error, first_failed_at, last_attempt_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      attempts      = excluded.attempts,
      last_error    = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at,
      next_retry_at = excluded.next_retry_at
  `).run(taskId, attempts, String(errorMessage || '').slice(0, 2000), nowIso, nowIso, nextRetry)
  return { attempts, nextRetry }
}

export function clearPushFailure(taskId, conn = db) {
  conn.prepare('DELETE FROM hubspot_push_failures WHERE task_id=?').run(taskId)
}

export function getPushFailureStatus(conn = db) {
  const row = conn.prepare(`
    SELECT COUNT(*) AS count, MIN(first_failed_at) AS oldest, MAX(attempts) AS max_attempts
    FROM hubspot_push_failures
  `).get()
  return {
    count: row?.count || 0,
    oldest: row?.oldest || null,
    max_attempts: row?.max_attempts || 0,
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
      if (!task) { clearPushFailure(taskId); return }
      const cache = await getOwnerCache()

      // Soft-deleted in ERP → archive in HS (if it exists there)
      if (task.deleted_at) {
        if (task.hubspot_task_id) {
          try { await deleteTask(task.hubspot_task_id) } catch (e) {
            if (!/404/.test(e.message)) throw e
          }
        }
        clearPushFailure(taskId)
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
      // Push réussi → la divergence est résorbée.
      clearPushFailure(taskId)
    } catch (e) {
      // Persiste l'échec pour reprise au lieu de l'avaler dans un log volatil.
      try {
        const { attempts, nextRetry } = recordPushFailure(taskId, e.message)
        console.error(`HubSpot push task ${taskId} (tentative ${attempts}, retry ${nextRetry}):`, e.message)
      } catch (persistErr) {
        console.error(`HubSpot push task ${taskId} (échec persistance file):`, persistErr.message, '— erreur d\'origine:', e.message)
      }
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

/**
 * Rejoue les push échoués dont next_retry_at est échu. Borné par `limit` pour
 * lisser la charge sur l'API HubSpot. pushTask() reclasse chaque tâche : succès
 * → ligne supprimée, nouvel échec → next_retry_at repoussé (backoff). Le JOIN
 * sur tasks ignore les tâches disparues (la ligne file est nettoyée par
 * ON DELETE CASCADE / clearPushFailure).
 */
export async function retryFailedPushes({ limit = 25 } = {}) {
  if (!isHubSpotConfigured()) return { attempted: 0, recovered: 0, stillFailing: 0 }
  const nowIso = new Date().toISOString()
  const due = db.prepare(`
    SELECT f.task_id FROM hubspot_push_failures f
    JOIN tasks t ON t.id = f.task_id
    WHERE f.next_retry_at IS NULL OR f.next_retry_at <= ?
    ORDER BY f.next_retry_at ASC
    LIMIT ?
  `).all(nowIso, limit)
  let recovered = 0, stillFailing = 0
  for (const { task_id } of due) {
    await pushTask(task_id)
    const still = db.prepare('SELECT 1 FROM hubspot_push_failures WHERE task_id=?').get(task_id)
    if (still) stillFailing++
    else recovered++
  }
  return { attempted: due.length, recovered, stillFailing }
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
 * Construit un suffixe de message d'erreur décrivant la progression partielle
 * d'un pull avant l'échec. Pur (testable sans DB ni réseau).
 *
 * `ctx` = objet `hubspotSearch` attaché à l'erreur par le connecteur :
 *   { windowFrom, windowTo, after, fetchedInWindow }
 */
export function describeSyncFailure({ processed = 0, modified = 0, ctx = {} } = {}) {
  const parts = [
    `tâches traitées avant l'échec: ${processed}`,
    `dont écrites en ERP: ${modified}`,
    ctx.windowFrom
      ? `fenêtre demandée: ${ctx.windowFrom} → ${ctx.windowTo}`
      : 'mode backfill (sans curseur)',
    ctx.after != null && ctx.after !== ''
      ? `curseur after: ${ctx.after}`
      : 'curseur after: (1re page de la fenêtre)',
  ]
  if (ctx.fetchedInWindow != null) {
    parts.push(`résultats récupérés dans la fenêtre fautive avant l'échec: ${ctx.fetchedInWindow}`)
  }
  return `[progression sync hubspot_tasks — ${parts.join(' · ')}]`
}

/**
 * Pull incremental changes from HubSpot. Also detects deletions by checking
 * whether tasks known to the ERP still exist on HubSpot.
 *
 * Le pull traite HubSpot fenêtre par fenêtre (cf. searchTasksModifiedSince) et
 * avance le curseur après chaque fenêtre appliquée. Si une fenêtre échoue (500
 * persistant), l'erreur remontée est enrichie via describeSyncFailure (curseur,
 * nb traité, fenêtre fautive) et `e.hubspotSyncProgress` porte les compteurs
 * partiels pour que sync_log les enregistre.
 */
export async function pullDelta({ full = false } = {}) {
  if (!isHubSpotConfigured()) return { modified: 0, destroyed: 0 }
  let modified = 0, destroyed = 0, processed = 0
  const cache = await getOwnerCache()
  const since = full ? null : getLastPullCursor()
  const startedAt = Date.now()
  const sinceMs = since ? new Date(since).getTime() : 0
  let maxModified = sinceMs

  // Applique les résultats d'une fenêtre HubSpot à l'ERP. Extrait en closure pour
  // le traitement incrémental : appelé une fois par fenêtre par
  // searchTasksModifiedSince.
  const applyResults = (results) => {
    for (const hs of results) {
      const hsModifiedMs = Date.parse(hs.properties?.hs_lastmodifieddate) || Date.now()
      if (hsModifiedMs > maxModified) maxModified = hsModifiedMs
      const hsId = String(hs.id)
      const existing = db.prepare('SELECT * FROM tasks WHERE hubspot_task_id=?').get(hsId)
      const fields = hsTaskToErpFields(hs, cache)
      processed++

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
  }

  try {
    await searchTasksModifiedSince(since, (results, win) => {
      applyResults(results)
      // Avance le curseur fenêtre par fenêtre (deltas seulement) : sur un échec
      // d'une fenêtre ultérieure, le prochain run reprend ici au lieu de tout
      // recommencer. On ancre sur maxModified (= plus récente modif vue) pour ne
      // pas dépasser ce qu'on a réellement appliqué.
      if (win.to != null && maxModified > sinceMs) {
        setLastPullCursor(new Date(maxModified).toISOString())
      }
    })
  } catch (e) {
    // Enrichit le message (visible dans sync_log.error_message) et attache les
    // compteurs partiels pour que l'appelant les journalise aussi.
    e.message = `${e.message} ${describeSyncFailure({ processed, modified, ctx: e.hubspotSearch || {} })}`
    e.hubspotSyncProgress = { processed, modified, destroyed, ...(e.hubspotSearch || {}) }
    throw e
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
  } else if (maxModified > sinceMs) {
    // Backstop : le curseur a déjà été avancé fenêtre par fenêtre ci-dessus,
    // on ré-ancre par sécurité sur la modif la plus récente réellement appliquée.
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

    // Tous les utilisateurs non supprimés (actifs ou non) : le mapping s'édite
    // désormais dans le tableau des utilisateurs (/admin/utilisateurs), qui
    // affiche aussi les comptes inactifs.
    const users = db.prepare("SELECT id, name, email, active, hubspot_owner_id FROM users WHERE deleted_at IS NULL ORDER BY name").all()
    return {
      configured: true,
      owners,
      push_failures: getPushFailureStatus(),
      users: users.map(u => {
        const autoId = cache.erpEmailToHsId.get((u.email || '').toLowerCase()) || null
        const overrideId = u.hubspot_owner_id || null
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          active: u.active,
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
