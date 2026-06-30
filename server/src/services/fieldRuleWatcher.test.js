// Tests for the field-rule watcher. Read-only against the real DB: exercises the
// cursor logic and the cross-file consistency of the watched-table list.

import test from 'node:test'
import assert from 'node:assert/strict'

import { pollOnce, WATCHED_TABLES, _setLastSeenId, _getLastSeenId } from './fieldRuleWatcher.js'
import { WRITABLE_TABLES } from './scriptSandbox.js'

test('the watched tables match the sandbox writable allowlist exactly', () => {
  // Drift between these two lists would let a rule write a table the watcher
  // never re-evaluates (or vice-versa). Keep them identical.
  assert.deepEqual(new Set(WATCHED_TABLES), WRITABLE_TABLES)
})

test('pollOnce never moves the cursor backwards and does not throw', async () => {
  _setLastSeenId(0)
  await pollOnce()
  const after = _getLastSeenId()
  assert.ok(after >= 0)
  await pollOnce()
  assert.ok(_getLastSeenId() >= after) // monotonic
})
