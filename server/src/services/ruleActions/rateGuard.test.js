// Unit tests for the anti-spam send guard.
//
// Runs against the real erp.db (no isolated test DB — cf. CLAUDE.md). It creates a
// single inactive throwaway automation as the FK parent for automation_send_log,
// then deletes it in after() — the send-log rows cascade away with it. The
// automation is active=0 so the field-rule engine never evaluates it even if the
// cleanup is delayed.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import db from '../../db/database.js'
import { makeRateGuard, isRateLimitedChannel, RATE_DEFAULTS } from './rateGuard.js'
import { resolveEmailTarget } from './email.js'
import { resolveSlackTarget } from './slack.js'

const AUTO_ID = `e2e-rateguard-${Date.now()}`

before(() => {
  db.prepare(`
    INSERT INTO automations (id, name, trigger_type, action_type, active, kind)
    VALUES (?, ?, 'manual', 'email', 0, 'field_rule')
  `).run(AUTO_ID, `E2E RateGuard ${Date.now()}`)
})

after(() => {
  // Cascade removes any automation_send_log rows created during the run.
  db.prepare('DELETE FROM automations WHERE id = ?').run(AUTO_ID)
})

function emailRule(rateLimit) {
  return {
    id: AUTO_ID,
    action_type: 'email',
    action_config: { to: 'Client@Example.com', rate_limit: rateLimit },
  }
}

test('resolveEmailTarget normalizes (lowercase, dedupe, sort, comma-join)', () => {
  assert.equal(
    resolveEmailTarget({ rule: { action_config: { to: 'B@x.com, a@X.com, b@x.com' } } }),
    'a@x.com,b@x.com'
  )
  assert.equal(resolveEmailTarget({ rule: { action_config: {} } }), null)
})

test('resolveSlackTarget keys on env name (not the secret URL) when configured', () => {
  assert.equal(resolveSlackTarget({ rule: { action_config: { webhookEnv: 'SLACK_X' } } }), 'env:SLACK_X')
  assert.equal(
    resolveSlackTarget({ rule: { action_config: { webhookUrl: 'https://hooks/abc' } } }),
    'https://hooks/abc'
  )
})

test('isRateLimitedChannel: only outgoing channels are guarded', () => {
  assert.equal(isRateLimitedChannel('email'), true)
  assert.equal(isRateLimitedChannel('slack'), true)
  assert.equal(isRateLimitedChannel('task'), false)
  assert.equal(isRateLimitedChannel('script'), false)
})

test('makeRateGuard is null for internal channels and for explicit opt-out', () => {
  assert.equal(makeRateGuard({ id: AUTO_ID, action_type: 'task', action_config: {} }), null)
  assert.equal(makeRateGuard({ id: AUTO_ID, action_type: 'script', action_config: {} }), null)
  assert.equal(makeRateGuard(emailRule({ enabled: false })), null)
  // A live channel with no rate_limit config still gets a guard (defaults apply).
  assert.notEqual(makeRateGuard(emailRule(undefined)), null)
})

test('per-recipient cap suppresses once the window count is reached', () => {
  const guard = makeRateGuard(emailRule({ window_minutes: 60, per_recipient: 2, per_automation: 0 }))

  let v = guard.check()
  assert.equal(v.ok, true)
  assert.equal(v.recipient, 'client@example.com') // normalized
  guard.record(v.recipient, 'orders', 'rec-1')

  v = guard.check()
  assert.equal(v.ok, true)
  guard.record(v.recipient, 'orders', 'rec-2')

  // Third send to the same recipient — over the cap of 2.
  v = guard.check()
  assert.equal(v.ok, false)
  assert.match(v.reason, /plafond destinataire/)
})

test('per-automation cap suppresses regardless of recipient', () => {
  // Distinct addresses each time so per-recipient never bites; only the global cap does.
  const mk = addr => ({
    id: AUTO_ID,
    action_type: 'email',
    action_config: { to: addr, rate_limit: { window_minutes: 60, per_recipient: 0, per_automation: 1 } },
  })
  // One row already exists for this automation from the previous test (rec-1/rec-2),
  // so the per_automation=1 cap is already met → next check must suppress.
  const guard = makeRateGuard(mk('someone-new@example.com'))
  const v = guard.check()
  assert.equal(v.ok, false)
  assert.match(v.reason, /plafond automation/)
})

test('cap of 0 means unlimited (opt-out of that dimension)', () => {
  const guard = makeRateGuard(emailRule({ window_minutes: 60, per_recipient: 0, per_automation: 0 }))
  // Even with many prior sends recorded, both caps disabled → always ok.
  for (let i = 0; i < 5; i++) {
    const v = guard.check()
    assert.equal(v.ok, true)
    guard.record(v.recipient, 'orders', `bulk-${i}`)
  }
})

test('defaults are applied when rate_limit is absent', () => {
  const guard = makeRateGuard({ id: AUTO_ID, action_type: 'email', action_config: { to: 'x@y.com' } })
  assert.equal(guard.config.perRecipient, RATE_DEFAULTS.per_recipient)
  assert.equal(guard.config.perAutomation, RATE_DEFAULTS.per_automation)
  assert.equal(guard.config.windowMin, RATE_DEFAULTS.window_minutes)
})
