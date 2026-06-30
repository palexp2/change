/**
 * Anti-spam guard for outgoing field-rule actions.
 *
 * fieldRuleEngine dispatches up to CANDIDATE_CAP (50) candidates per evaluation,
 * and a misconfigured rule (or a sync that touches many rows at once) could blast
 * dozens of emails / Slack messages to the same recipient in minutes — burning the
 * domain's sending reputation. This guard enforces a sliding-window frequency cap,
 * both per-recipient and per-automation, on the client-facing channels (email,
 * slack). Internal channels (task, script) are never throttled.
 *
 * Every SUCCESSFUL send is recorded in `automation_send_log`; the next candidate's
 * check counts rows in the window. Suppressed candidates are NOT marked as fired —
 * the engine re-queues them as deferred candidates so the background drain retries
 * them once the window clears, spreading the sends over time instead of dropping
 * them.
 *
 * Caps are configurable per rule via `action_config.rate_limit`:
 *   {
 *     enabled: true,            // set false to opt out entirely
 *     window_minutes: 60,       // sliding window length
 *     per_recipient: 5,         // max sends to one recipient in the window (0 = unlimited)
 *     per_automation: 50,       // max sends total for this rule in the window (0 = unlimited)
 *   }
 * Missing keys fall back to the conservative defaults below.
 */
import db from '../../db/database.js'
import { resolveEmailTarget } from './email.js'
import { resolveSlackTarget } from './slack.js'

// Defaults tuned to stop "dozens to the same client in minutes" while leaving
// normal traffic untouched. Generous enough that a single full evaluation of a
// legitimate rule fires, tight enough that a runaway rule self-throttles.
export const RATE_DEFAULTS = { window_minutes: 60, per_recipient: 5, per_automation: 50 }

// Recipient resolvers per channel. The presence of a channel here is what makes it
// "rate-limited": only outgoing, reputation-bearing channels appear.
const RESOLVERS = {
  email: resolveEmailTarget,
  slack: resolveSlackTarget,
}

export function isRateLimitedChannel(actionType) {
  return Object.prototype.hasOwnProperty.call(RESOLVERS, actionType)
}

function nonNegInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function resolveConfig(rule) {
  const rl = (rule.action_config && rule.action_config.rate_limit) || {}
  if (rl.enabled === false) return null // explicit opt-out — no throttling
  const windowMin = nonNegInt(rl.window_minutes, RATE_DEFAULTS.window_minutes) || RATE_DEFAULTS.window_minutes
  return {
    windowMin,
    perRecipient: nonNegInt(rl.per_recipient, RATE_DEFAULTS.per_recipient), // 0 = unlimited
    perAutomation: nonNegInt(rl.per_automation, RATE_DEFAULTS.per_automation),
  }
}

/**
 * Build a stateful guard for one dispatch run, or null when the channel isn't
 * rate-limited / the rule opted out. The returned guard is consulted per candidate:
 *
 *   const guard = makeRateGuard(rule)
 *   const v = guard.check()                 // { ok, recipient?, reason? }
 *   if (!v.ok) { suppress(v.reason); continue }
 *   await adapter(...)                      // only on ok
 *   guard.record(v.recipient, table, id)    // only after a successful send
 *
 * Because record() commits to automation_send_log immediately, later candidates in
 * the same batch see earlier sends — so the in-batch fan-out is throttled too.
 */
export function makeRateGuard(rule) {
  if (!isRateLimitedChannel(rule.action_type)) return null
  const cfg = resolveConfig(rule)
  if (!cfg) return null

  const channel = rule.action_type
  const automationId = rule.id
  const resolver = RESOLVERS[channel]
  // Sliding window: count rows newer than (now - windowMin). windowMin is a vetted
  // integer, safe to interpolate into the strftime modifier.
  const sinceExpr = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${cfg.windowMin} minutes')`
  const countAuto = db.prepare(
    `SELECT COUNT(*) AS n FROM automation_send_log
     WHERE automation_id=? AND channel=? AND sent_at >= ${sinceExpr}`
  )
  const countRecip = db.prepare(
    `SELECT COUNT(*) AS n FROM automation_send_log
     WHERE automation_id=? AND channel=? AND recipient=? AND sent_at >= ${sinceExpr}`
  )
  const insert = db.prepare(
    `INSERT INTO automation_send_log (automation_id, channel, recipient, record_table, record_id)
     VALUES (?, ?, ?, ?, ?)`
  )

  return {
    channel,
    config: cfg,
    /**
     * Decide whether the next send is allowed. Returns:
     *   { ok: true, recipient }   — go ahead; pass `recipient` back to record()
     *   { ok: false, reason }     — suppress this candidate
     * If the recipient can't be resolved (missing env, etc.) the guard steps aside
     * (ok:true, recipient null) and lets the adapter raise the real error.
     */
    check() {
      let recipient
      try {
        recipient = resolver({ rule })
      } catch {
        return { ok: true, recipient: null }
      }
      if (!recipient) return { ok: true, recipient: null }

      if (cfg.perAutomation > 0) {
        const total = countAuto.get(automationId, channel).n
        if (total >= cfg.perAutomation) {
          return {
            ok: false,
            reason: `plafond automation atteint (${cfg.perAutomation} envoi(s)/${cfg.windowMin} min)`,
          }
        }
      }
      if (cfg.perRecipient > 0) {
        const c = countRecip.get(automationId, channel, recipient).n
        if (c >= cfg.perRecipient) {
          return {
            ok: false,
            reason: `plafond destinataire atteint pour ${recipient} (${cfg.perRecipient}/${cfg.windowMin} min)`,
          }
        }
      }
      return { ok: true, recipient }
    },
    /** Record a successful send so it counts against future windows. No-op on a null key. */
    record(recipient, recordTable, recordId) {
      if (!recipient) return
      insert.run(automationId, channel, recipient, recordTable || null, recordId || null)
    },
  }
}
