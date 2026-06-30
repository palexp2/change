// Tests for the script sandbox guards. Only exercises throwing/read-only paths
// so nothing is written to the real DB (prod DB == test DB).

import test from 'node:test'
import assert from 'node:assert/strict'

import { runScriptSandboxed, WRITABLE_TABLES } from './scriptSandbox.js'

test('read-only mode does not expose update()', async () => {
  await assert.rejects(
    runScriptSandboxed('update("orders", "x", { a: 1 })', { enableWrite: false }),
    /update is not defined/
  )
})

test('update() rejects tables outside the allowlist before any DB access', async () => {
  await assert.rejects(
    runScriptSandboxed('update("automations", "x", { active: 0 })', { enableWrite: true }),
    /table non autorisée/
  )
  await assert.rejects(
    runScriptSandboxed('update("sqlite_master", "x", { a: 1 })', { enableWrite: true }),
    /table non autorisée/
  )
})

test('update() rejects an unknown column without writing', async () => {
  // `orders` is allowlisted and real; the bogus column is caught by the
  // table_info validation loop before the UPDATE statement is prepared.
  await assert.rejects(
    runScriptSandboxed('update("orders", "nonexistent-id", { __nope__: 1 })', { enableWrite: true }),
    /colonne inexistante/
  )
})

test('update() refuses to mutate the id column', async () => {
  await assert.rejects(
    runScriptSandboxed('update("orders", "x", { id: "y" })', { enableWrite: true }),
    /id est immuable/
  )
})

test('query() only allows SELECT', async () => {
  await assert.rejects(
    runScriptSandboxed('query("DELETE FROM orders")', { enableWrite: true }),
    /uniquement les requêtes SELECT/
  )
})

test('the triggering row is exposed to the script as `row`', async () => {
  const { output } = await runScriptSandboxed('log(row.foo)', {
    row: { foo: 'bar' },
    enableWrite: true,
  })
  assert.equal(output, 'bar')
})

test('the writable-table allowlist matches the 7 agreed tables', () => {
  assert.ok(WRITABLE_TABLES.has('orders'))
  assert.ok(WRITABLE_TABLES.has('factures'))
  assert.equal(WRITABLE_TABLES.size, 7)
})
