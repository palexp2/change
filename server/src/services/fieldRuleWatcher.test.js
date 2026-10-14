// Tests for the field-rule watcher. Read-only against the real DB: exercises the
// cursor logic and the cross-file consistency of the watched-table list.

import test from 'node:test'
import assert from 'node:assert/strict'

import { pollOnce, WATCHED_TABLES, _setLastSeenId, _getLastSeenId } from './fieldRuleWatcher.js'
import { WRITABLE_TABLES } from './scriptSandbox.js'

test('every sandbox-writable table is watched (plus return_items)', () => {
  // A rule writing a table the watcher never re-evaluates would break chains.
  assert.deepEqual(new Set(WATCHED_TABLES), new Set([...WRITABLE_TABLES, 'return_items']))
})

test('pollOnce never moves the cursor backwards and does not throw', async () => {
  _setLastSeenId(0)
  await pollOnce()
  const after = _getLastSeenId()
  assert.ok(after >= 0)
  await pollOnce()
  assert.ok(_getLastSeenId() >= after) // monotonic
})
