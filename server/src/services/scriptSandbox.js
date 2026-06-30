import { createContext, runInNewContext } from 'node:vm'
import db from '../db/database.js'
import { sendEmail as gmailSendEmail } from './gmail.js'

/**
 * Shared sandbox for user-authored automation scripts.
 *
 * Scripts run in a `node:vm` context with a 10s synchronous timeout and a tiny
 * curated global surface (no `require`, `fs`, `process`). Two execution modes:
 *  - read-only (legacy trigger_type automations): `query` (SELECT), `fetch`,
 *    `sendEmail`, `log`. No DB mutation.
 *  - read+write (field_rule `script` actions): adds `update(table, id, patch)`,
 *    restricted to a whitelist of tables, parameterized, with anti-cycle guards.
 *
 * Loop safety: a write goes through the change_log triggers like any other
 * mutation, so the fieldRuleWatcher re-evaluates the touched record. That can
 * never loop indefinitely because automation_rule_fires makes each (rule,
 * record) pair fire at most once (NOT EXISTS dedup in the candidate query).
 * On top of that one-shot guarantee, update() refuses to write a column that is
 * itself a trigger column of an active rule (unless allow_trigger_write).
 */

// Tables a triggered script may write to. Mirrors the fieldRuleWatcher's watched
// set. Anything outside this set is rejected by update().
export const WRITABLE_TABLES = new Set([
  'factures', 'products', 'orders', 'shipments', 'companies', 'contacts', 'serial_numbers',
])

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

// Columns currently used as a trigger column by an active field_rule on `table`.
// Writing one of these would risk a rule re-firing on its own effect, so they
// are protected unless the rule opts in via allow_trigger_write.
function triggerColumns(table) {
  const rows = db.prepare(`
    SELECT trigger_config FROM automations
    WHERE kind='field_rule' AND active=1 AND deleted_at IS NULL
  `).all()
  const cols = new Set()
  for (const r of rows) {
    try {
      const tc = JSON.parse(r.trigger_config || '{}')
      if (tc.erp_table === table && tc.column) cols.add(tc.column)
    } catch { /* malformed config is surfaced elsewhere */ }
  }
  return cols
}

function makeUpdate({ allowTriggerWrite, logs, writableTables = WRITABLE_TABLES }) {
  return (table, id, patch) => {
    if (!writableTables.has(table)) {
      throw new Error(`update(): table non autorisée: ${table}`)
    }
    if (!id) throw new Error('update(): id requis')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('update(): patch doit être un objet { colonne: valeur }')
    }
    const keys = Object.keys(patch)
    if (!keys.length) return 0

    // `table` comes from WRITABLE_TABLES (a literal allowlist), so interpolating
    // it into PRAGMA / UPDATE is safe; values are always bound parameters.
    const validCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name))
    const protectedCols = allowTriggerWrite ? new Set() : triggerColumns(table)

    for (const k of keys) {
      if (!IDENT_RE.test(k)) throw new Error(`update(): nom de colonne invalide: ${k}`)
      if (k === 'id') throw new Error('update(): la colonne id est immuable')
      if (!validCols.has(k)) throw new Error(`update(): colonne inexistante ${table}.${k}`)
      if (protectedCols.has(k)) {
        throw new Error(
          `update(): ${table}.${k} est une colonne-déclencheur (garde anti-cycle). ` +
          `Coche allow_trigger_write sur la règle pour l'autoriser.`
        )
      }
    }

    const setSql = keys.map(k => `${k} = ?`).join(', ')
    const params = keys.map(k => {
      const v = patch[k]
      // SQLite bindings accept null/number/string/bigint/buffer — coerce the
      // rest (objects/booleans/arrays) to a stable representation.
      if (v === null || v === undefined) return null
      if (typeof v === 'boolean') return v ? 1 : 0
      if (typeof v === 'object') return JSON.stringify(v)
      return v
    })
    const info = db.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`).run(...params, id)
    logs.push(`✏️ update(${table}, ${id}) → ${info.changes} ligne(s)`)
    // The change_log AFTER UPDATE trigger records this mutation; the
    // fieldRuleWatcher will re-evaluate the record. No explicit re-trigger here.
    return info.changes
  }
}

function buildSandbox({ row, trigger, enableWrite, allowTriggerWrite, logs, params, request, writableTables, respond }) {
  const sandbox = {
    log: (...args) => {
      logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    },
    console: {
      log: (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
      },
    },

    fetch: async (url, options = {}) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await globalThis.fetch(url, { ...options, signal: controller.signal })
        clearTimeout(timeout)
        const text = await res.text()
        let json
        try { json = JSON.parse(text) } catch { json = null }
        return { ok: res.ok, status: res.status, text, json }
      } catch (err) {
        clearTimeout(timeout)
        throw new Error(`Fetch failed: ${err.message}`)
      }
    },

    // Safe read-only query against native ERP tables (SELECT only)
    query: (sql, params = []) => {
      const trimmed = (sql || '').trim().toUpperCase()
      if (!trimmed.startsWith('SELECT')) throw new Error('query() accepte uniquement les requêtes SELECT')
      return db.prepare(sql).all(...(params || []))
    },

    // Send an email via the connected Google account
    sendEmail: async (to, subject, htmlBody) => {
      await gmailSendEmail(to, subject, htmlBody)
      logs.push(`📧 Email envoyé à ${to} — ${subject}`)
    },

    // The record that triggered the rule (null for legacy trigger_type scripts)
    row: row || null,
    // Trigger metadata (rule id, table, raw trigger payload)
    trigger: trigger || {},

    Date, Math, JSON,
    parseInt, parseFloat, isNaN, Number, String, Boolean, Array, Object,
  }
  // Webhook mode extras : params reçus (query ∪ body), métadonnées requête, et
  // respond(status, body) pour fixer la réponse HTTP renvoyée à l'appelant.
  if (params) sandbox.params = params
  if (request) sandbox.request = request
  if (respond) sandbox.respond = respond
  if (enableWrite) {
    sandbox.update = makeUpdate({ allowTriggerWrite, logs, writableTables })
  }
  return sandbox
}

/**
 * Execute a user script in the sandbox. Returns { output, logs }.
 * Throws on script error or timeout (caller logs the failure).
 */
export async function runScriptSandboxed(script, {
  row = null,
  trigger = {},
  enableWrite = false,
  allowTriggerWrite = false,
  timeoutMs = 10000,
  params = null,
  request = null,
  writableTables = WRITABLE_TABLES,
} = {}) {
  const logs = []
  // Holder pour respond() : le script peut fixer la réponse HTTP du webhook.
  const responseHolder = { value: null }
  const respond = params
    ? (status, body) => { responseHolder.value = { status: Number(status) || 200, body: body ?? null } }
    : null
  const sandbox = buildSandbox({ row, trigger, enableWrite, allowTriggerWrite, logs, params, request, writableTables, respond })
  const context = createContext(sandbox)
  try {
    await runInNewContext(
      `(async () => { ${script || ''} })()`,
      context,
      { timeout: timeoutMs }
    )
  } catch (err) {
    // Surface whatever the script logged before it failed, so callers can
    // persist partial output alongside the error.
    err.partialOutput = logs.join('\n') || null
    throw err
  }
  return { output: logs.join('\n') || null, logs, response: responseHolder.value }
}
