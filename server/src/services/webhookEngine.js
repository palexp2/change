import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { newId } from '../utils/ids.js'
import { runScriptSandboxed } from './scriptSandbox.js'
import { writeBackRecord, createInAirtable, TABLE_TO_WRITEBACK_MODULE } from './airtableWriteback.js'
import { sendEmail as sendRuleEmail } from './ruleActions/email.js'
import { emitEntity } from './realtimeEmitters.js'
import { escapeHtml } from '../utils/sanitizeHtml.js'

/**
 * Moteur d'exécution des webhooks (automations kind='webhook').
 *
 * Déclenché par le routeur public /api/hooks/:token. Pour chaque appel :
 *   1. construit `params` = query ∪ body (body écrase query sur clé identique) ;
 *   2. exécute l'action — déclarative (liste ordonnée de steps update/upsert/create)
 *      ou script (scriptSandbox avec params/request/respond) ;
 *   3. évalue les règles de réponse (première qui matche, sinon réponse par défaut) ;
 *   4. journalise le déclenchement dans automation_logs (payload + actions + temps) ;
 *   5. en cas d'échec, envoie un courriel à l'employé configuré (throttlé).
 *
 * Tables écrivables : tickets, projects, serial_numbers. Toute écriture sur une
 * colonne mappée Airtable est répercutée via writeBackRecord/createInAirtable
 * (les colonnes ERP-natives restent en DB, jamais clobberées par le sync entrant).
 */

const WEBHOOK_TABLES = new Set(Object.keys(TABLE_TO_WRITEBACK_MODULE)) // tickets, projects, serial_numbers
const TABLE_ENTITY = { tickets: 'ticket', projects: 'project', serial_numbers: 'serial_number' }
// Colonnes NOT NULL sans valeur par défaut → obligatoires pour un create/upsert-create.
const REQUIRED_COLS = { tickets: [], projects: ['name'], serial_numbers: ['serial'] }
const FAILURE_THROTTLE_MS = 15 * 60 * 1000
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

// Cache des colonnes valides par table (PRAGMA), pour valider les noms de colonnes
// avant interpolation SQL. Les tables venant de WEBHOOK_TABLES (allowlist littérale)
// sont sûres à interpoler ; les colonnes sont validées contre ce set.
const colCache = new Map()
function tableCols(table) {
  if (!colCache.has(table)) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
    colCache.set(table, cols)
  }
  return colCache.get(table)
}

// Résout la valeur d'un champ {column, source, value} contre les params et un
// éventuel record matché. source : 'param' (valeur entrante), 'record' (valeur
// existante du record matché), sinon littéral.
function resolveValue(spec, params, record) {
  if (!spec || typeof spec !== 'object') return null
  if (spec.source === 'param') return params[spec.value] ?? null
  if (spec.source === 'record') return record ? (record[spec.value] ?? null) : null
  return spec.value ?? null // littéral
}

// Construit le patch {colonne: valeur} d'un step pour un record cible donné.
function buildPatch(fields, params, record, table, stepNo) {
  const validCols = tableCols(table)
  const patch = {}
  for (const f of (fields || [])) {
    const col = f?.column
    if (!IDENT_RE.test(col || '') || !validCols.has(col)) {
      throw new Error(`Étape ${stepNo}: colonne invalide ${table}.${col}`)
    }
    if (col === 'id') throw new Error(`Étape ${stepNo}: la colonne id est immuable`)
    patch[col] = resolveValue(f, params, record)
  }
  return patch
}

function emitSafe(table, verb, id, row, actorUserId = null) {
  try { emitEntity(TABLE_ENTITY[table], verb, id, row, actorUserId) } catch { /* realtime best-effort */ }
}

// Applique un UPDATE sur un record existant, puis write-back Airtable best-effort.
async function applyUpdate(table, id, patch, actions, dryRun) {
  const keys = Object.keys(patch)
  if (!keys.length) return
  if (dryRun) { actions.push(`[test] update(${table}, ${id}) → ${keys.join(', ')}`); return }
  const setSql = keys.map(k => `${k} = ?`).join(', ')
  const vals = keys.map(k => coerce(patch[k]))
  db.prepare(`UPDATE ${table} SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(...vals, id)
  actions.push(`update(${table}, ${id}) → ${keys.join(', ')}`)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  emitSafe(table, 'updated', id, row)
  await pushAirtable(table, id, keys, actions)
}

// Crée un record, puis pousse la création vers Airtable best-effort.
async function applyCreate(table, patch, actions, stepNo, dryRun) {
  for (const req of (REQUIRED_COLS[table] || [])) {
    if (patch[req] == null || patch[req] === '') {
      throw new Error(`Étape ${stepNo}: colonne requise « ${req} » manquante pour créer ${table}`)
    }
  }
  if (dryRun) {
    actions.push(`[test] create(${table}) → ${Object.keys(patch).join(', ') || '(vide)'}`)
    return { ...patch } // record synthétique pour le templating
  }
  const id = newRecordId()
  const keys = Object.keys(patch)
  const cols = ['id', ...keys]
  const placeholders = cols.map(() => '?').join(', ')
  const vals = [id, ...keys.map(k => coerce(patch[k]))]
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals)
  actions.push(`create(${table}, ${id}) → ${keys.join(', ') || '(vide)'}`)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  emitSafe(table, 'created', id, row)
  // Création côté Airtable (pose l'airtable_id pour que le record ne soit pas orphelin).
  const module = TABLE_TO_WRITEBACK_MODULE[table]
  const res = await createInAirtable(module, id)
  if (res?.error) throw new Error(`create Airtable ${table}: ${res.error}`)
  return row
}

// Write-back d'un update vers Airtable. Les cas bénins (config absente, record non
// lié, aucun champ mappé) renvoient {skipped} et ne font pas échouer le webhook ;
// seule une vraie erreur réseau/API Airtable lève (→ échec + courriel).
async function pushAirtable(table, id, changedCols, actions) {
  const module = TABLE_TO_WRITEBACK_MODULE[table]
  const res = await writeBackRecord(module, id, changedCols)
  if (res?.error) throw new Error(`write-back ${table}: ${res.error}`)
  if (res?.ok) actions.push(`write-back ${table} → Airtable (${Object.keys(res.fields).join(', ')})`)
}

// SQLite n'accepte que null/number/string/bigint/buffer en binding.
function coerce(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

// Exécute un step déclaratif. Retourne la liste des records touchés (pour le
// templating des règles de réponse). Lève en cas d'échec (0-match sur update,
// colonne invalide, erreur write-back…).
async function runStep(step, index, params, actions, dryRun) {
  const stepNo = index + 1
  const type = step?.type || 'update'
  const table = step?.table
  if (!WEBHOOK_TABLES.has(table)) throw new Error(`Étape ${stepNo}: table non autorisée: ${table}`)

  if (type === 'create') {
    const patch = buildPatch(step.fields, params, null, table, stepNo)
    const row = await applyCreate(table, patch, actions, stepNo, dryRun)
    return [row]
  }

  // update / upsert : recherche par match.field == params[match.param] (insensible à la casse)
  const field = step?.match?.field
  const validCols = tableCols(table)
  if (!IDENT_RE.test(field || '') || !validCols.has(field)) {
    throw new Error(`Étape ${stepNo}: champ de recherche invalide ${table}.${field}`)
  }
  const matchVal = params[step?.match?.param]
  const rows = (matchVal === undefined || matchVal === null)
    ? []
    : db.prepare(`SELECT * FROM ${table} WHERE ${field} = ? COLLATE NOCASE`).all(String(matchVal))

  if (rows.length === 0) {
    if (type === 'upsert') {
      const patch = buildPatch(step.fields, params, null, table, stepNo)
      const row = await applyCreate(table, patch, actions, stepNo, dryRun)
      return [row]
    }
    // update : 0-match = échec
    throw new Error(`Étape ${stepNo}: aucun ${table} où ${field} = « ${matchVal ?? ''} »`)
  }

  // 1+ matches : on applique le set à TOUS les records matchés.
  for (const row of rows) {
    const patch = buildPatch(step.fields, params, row, table, stepNo)
    await applyUpdate(table, row.id, patch, actions, dryRun)
  }
  if (dryRun) return rows
  // Re-lire les records frais pour le templating.
  return rows.map(r => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.id))
}

// ── Règles de réponse ────────────────────────────────────────────────────────

function tokenValue(path, ctx) {
  const parts = String(path).split('.').map(s => s.trim())
  if (parts[0] === 'param') return ctx.params[parts[1]] ?? ''
  if (parts[0] === 'steps') {
    const recs = ctx.matched[Number(parts[1])]
    if (parts[2] === 'record' && recs && recs[0]) return recs[0][parts[3]] ?? ''
  }
  return ''
}

function renderTemplate(node, ctx) {
  if (typeof node === 'string') {
    return node.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => String(tokenValue(p, ctx)))
  }
  if (Array.isArray(node)) return node.map(n => renderTemplate(n, ctx))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = renderTemplate(v, ctx)
    return out
  }
  return node
}

function ruleMatches(rule, params) {
  const op = rule.op || 'eq'
  const actual = params[rule.param]
  if (op === 'exists') return actual !== undefined && actual !== null && actual !== ''
  if (op === 'ne') return String(actual ?? '') !== String(rule.value ?? '')
  return String(actual ?? '') === String(rule.value ?? '') // eq
}

function evaluateResponse(config, ctx) {
  for (const rule of (config.response_rules || [])) {
    if (ruleMatches(rule, ctx.params)) {
      return { status: Number(rule.status) || 200, body: renderTemplate(rule.body ?? { ok: true }, ctx) }
    }
  }
  const def = config.default_response
  if (def) return { status: Number(def.status) || 200, body: renderTemplate(def.body ?? { ok: true }, ctx) }
  return { status: 200, body: { ok: true } }
}

// ── Journalisation + courriel d'échec ────────────────────────────────────────

function logWebhook(automationId, status, ctx, actions, response, error, durationMs) {
  const triggerData = {
    method: ctx.method,
    query: ctx.query,
    body: ctx.body,
    params: ctx.params,
    actions,
    response,
  }
  db.prepare(`
    INSERT INTO automation_logs (id, automation_id, status, trigger_data, result, error, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('log'), automationId, status,
    JSON.stringify(triggerData),
    actions.length ? actions.join('\n') : null,
    error, durationMs,
  )
  db.prepare(`
    UPDATE automations SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      last_run_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(status, automationId)
}

async function maybeSendFailureEmail(automation, config, ctx, errorMsg, actions) {
  const to = config.failure_recipient
  if (!to) return
  // Throttle : au plus un courriel par webhook par fenêtre.
  const row = db.prepare('SELECT last_sent_at FROM webhook_failure_throttle WHERE automation_id = ?').get(automation.id)
  if (row?.last_sent_at) {
    const age = Date.now() - new Date(row.last_sent_at).getTime()
    if (age >= 0 && age < FAILURE_THROTTLE_MS) return // déjà notifié récemment
  }
  try {
    const html = `
      <p>Le webhook <strong>${escapeHtml(automation.name)}</strong> a échoué.</p>
      <p><strong>Erreur :</strong> ${escapeHtml(errorMsg)}</p>
      <p><strong>Méthode :</strong> ${escapeHtml(ctx.method)}</p>
      <p><strong>Params reçus :</strong></p>
      <pre>${escapeHtml(JSON.stringify(ctx.params, null, 2))}</pre>
      <p><strong>Actions tentées :</strong></p>
      <pre>${escapeHtml(actions.join('\n') || '(aucune)')}</pre>
    `
    await sendRuleEmail({
      rule: { action_config: { to } },
      rendered: { subject: `[Webhook] Échec : ${automation.name}`, bodyHtml: html },
    })
    db.prepare(`
      INSERT INTO webhook_failure_throttle (automation_id, last_sent_at)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(automation_id) DO UPDATE SET last_sent_at = excluded.last_sent_at
    `).run(automation.id)
  } catch (e) {
    // Un échec d'envoi du courriel d'échec ne doit pas masquer l'erreur d'origine.
    console.error(`❌ Courriel d'échec webhook ${automation.id}:`, e.message)
  }
}

/**
 * Point d'entrée : exécute un webhook et renvoie la réponse HTTP à émettre.
 * @param automation  ligne automations (kind='webhook')
 * @param ctx         { method, query, body, params, rawBody, headers }
 * @returns { status, body }
 */
export async function runWebhook(automation, ctx) {
  const t0 = Date.now()
  const dryRun = !!ctx.dryRun
  const params = ctx.params || {}
  const actions = []
  const matched = [] // records matchés par index de step (pour le templating)
  let config
  try { config = JSON.parse(automation.action_config || '{}') } catch { config = {} }
  const mode = config.mode === 'script' ? 'script' : 'declarative'

  try {
    let response = null
    if (mode === 'script') {
      // En test, le script n'est pas exécuté (le sandbox écrit en DB sans rollback) :
      // on ne peut pas garantir l'absence d'effet de bord. On le signale plutôt.
      if (dryRun) {
        actions.push('[test] mode script — exécution réelle non simulée, utilisez l\'URL du webhook pour tester')
      } else {
        const { logs, response: scriptResp } = await runScriptSandboxed(automation.script || '', {
          params,
          request: { method: ctx.method, query: ctx.query, body: ctx.body, headers: ctx.headers },
          enableWrite: true,
          allowTriggerWrite: true,
          writableTables: WEBHOOK_TABLES,
        })
        if (logs?.length) actions.push(...logs)
        response = scriptResp
      }
    } else {
      const steps = Array.isArray(config.steps) ? config.steps : []
      for (let i = 0; i < steps.length; i++) {
        matched[i] = await runStep(steps[i], i, params, actions, dryRun)
      }
    }
    if (!response) response = evaluateResponse(config, { params, matched })
    if (!dryRun) logWebhook(automation.id, 'success', ctx, actions, response, null, Date.now() - t0)
    return dryRun ? { ...response, dryRun: true, actions } : response
  } catch (err) {
    const errorMsg = err?.message || 'Erreur webhook'
    if (dryRun) return { status: 500, body: { error: errorMsg }, dryRun: true, actions }
    logWebhook(automation.id, 'error', ctx, actions, null, errorMsg, Date.now() - t0)
    await maybeSendFailureEmail(automation, config, ctx, errorMsg, actions)
    return { status: 500, body: { error: errorMsg } }
  }
}

export const WEBHOOK_WRITABLE_TABLES = WEBHOOK_TABLES
