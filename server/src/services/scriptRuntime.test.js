import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { runScriptSandboxed, scriptRuntimeStatus } from './scriptSandbox.js'
import { ScriptQueue } from './scriptRuntime/queue.js'
import { publicIPv4, scriptFetch } from './scriptRuntime/network.js'
import { limits } from './scriptRuntime/config.js'
initTestDb()

test('FIFO queue bounds concurrency and capacity and preserves caller context', async () => {
  const q = new ScriptQueue({ concurrency: 1, queueSize: 2, queueTimeoutMs: 1000 })
  const context = new AsyncLocalStorage()
  const events = []
  let release
  const first = q.run(() => new Promise(resolve => { release = resolve }))
  await delay(0)
  const second = context.run('second', () => q.run(async () => events.push(context.getStore())))
  const third = context.run('third', () => q.run(async () => events.push(context.getStore())))
  assert.equal(q.status().active, 1)
  assert.equal(q.status().queued, 2)
  await assert.rejects(q.run(() => {}), { code: 'SCRIPT_QUEUE_FULL' })
  release()
  await Promise.all([first, second, third])
  assert.deepEqual(events, ['second', 'third'])
  await delay(0)
  assert.equal(q.status().active, 0)
})

test('queue wait expiry, cancellation and shutdown do not execute queued work', async () => {
  const q = new ScriptQueue({ concurrency: 1, queueSize: 2, queueTimeoutMs: 30 })
  let release, ran = false
  const first = q.run(signal => new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve) }))
  await delay(0)
  await assert.rejects(q.run(() => { ran = true }), { code: 'SCRIPT_QUEUE_TIMEOUT' })
  const controller = new AbortController()
  const cancelled = q.run(() => { ran = true }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, { code: 'SCRIPT_CANCELLED' })
  const pending = q.run(() => { ran = true })
  q.shutdown()
  await assert.rejects(pending, { code: 'SCRIPT_SHUTDOWN' })
  await assert.rejects(q.run(() => {}), { code: 'SCRIPT_SHUTDOWN' })
  release(); await first
  assert.equal(ran, false)
})

test('synchronous query/update and webhook response survive the process boundary', async () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('sandbox-fixture', 'Before')").run()
  const result = await runScriptSandboxed(`
    const rows = query('SELECT id, name FROM companies WHERE id = ?', ['sandbox-fixture']);
    log(rows[0].name);
    const count = update('companies', rows[0].id, { name: 'After' });
    respond(201, { count, value: params.value });
  `, { enableWrite: true, params: { value: 'fixture' } })
  assert.match(result.output, /Before/)
  assert.match(result.output, /update\(companies/)
  assert.deepEqual(result.response, { status: 201, body: { count: 1, value: 'fixture' } })
  assert.equal(db.prepare("SELECT name FROM companies WHERE id='sandbox-fixture'").get().name, 'After')
})

test('secret tables, nested SQL reads and extension/file functions are denied', async () => {
  for (const sql of ['SELECT * FROM users', 'SELECT * FROM connector_oauth', 'SELECT (SELECT password_hash FROM users LIMIT 1)', "SELECT load_extension('/tmp/test')", 'SELECT * FROM pragma_table_info(\'users\')']) {
    await assert.rejects(runScriptSandboxed(`query(${JSON.stringify(sql)})`), /prohibited|authorized|authorization|not allowed|access/i)
  }
})

test('even a vm escape cannot reach the host files, environment or processes', async () => {
  process.env.BOREAL_SANDBOX_CANARY = 'must-not-reach-guest'
  const result = await runScriptSandboxed(`
    const p = log.constructor('return process')();
    const fs = p.mainModule.require('node:fs');
    log(p.env.BOREAL_SANDBOX_CANARY === undefined);
    log(fs.existsSync('/home/ec2-user/erp/server/.env'));
    log(fs.existsSync('/proc/1/root/home/ec2-user/erp/server/.env'));
    log(fs.existsSync('/run/user/1000/bus'));
    log(fs.existsSync('/usr/bin/sudo'));
    try { fs.writeFileSync('/sandbox/probe', 'x'); log('write succeeded') } catch { log('read-only') }
  `)
  assert.equal(result.output, 'true\nfalse\nfalse\nfalse\nfalse\nread-only')
})

test('guest cannot connect directly to the host loopback network', async t => {
  let reached = false
  const http = createServer((_req, res) => { reached = true; res.end('host') })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => http.close())
  const result = await runScriptSandboxed(`
    const p = log.constructor('return process')();
    try { await p.mainModule.require('node:http').get('http://127.0.0.1:${http.address().port}').on('error', () => {}); log('started') } catch { log('denied') }
    await new Promise(resolve => p.mainModule.require('node:timers').setTimeout(resolve, 80));
  `)
  assert.ok(result)
  assert.equal(reached, false)
})

test('network and email broker are deny-by-default and private addresses stay blocked', async () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '::1', '100.64.0.1']) assert.equal(publicIPv4(ip), false)
  assert.equal(publicIPv4('8.8.8.8'), true)
  await assert.rejects(runScriptSandboxed("await fetch('http://169.254.169.254/latest/meta-data/')"), /non autorisée/)
  await assert.rejects(runScriptSandboxed("await sendEmail('nobody@example.com','test','test')"), /non autorisé/)
  const saved = process.env.SCRIPT_FETCH_ORIGINS
  process.env.SCRIPT_FETCH_ORIGINS = 'https://127.0.0.1'
  try { await assert.rejects(scriptFetch('https://127.0.0.1', {}, new AbortController().signal), /privée/) }
  finally { if (saved === undefined) delete process.env.SCRIPT_FETCH_ORIGINS; else process.env.SCRIPT_FETCH_ORIGINS = saved }
})

test('wall deadline kills synchronous loops, async loops and unresolved promises; queue recovers', async () => {
  for (const script of ['while (true) {}', 'await Promise.resolve(); while (true) {}', 'await new Promise(() => {})']) {
    const start = Date.now()
    await assert.rejects(runScriptSandboxed(script, { timeoutMs: 600 }), error => ['SCRIPT_TIMEOUT', 'SCRIPT_PROCESS_FAILED'].includes(error.code))
    assert.ok(Date.now() - start < 3000)
  }
  assert.equal((await runScriptSandboxed("log('recovered')")).output, 'recovered')
})

test('external memory cap kills Buffer allocation outside the V8 heap', async () => {
  await assert.rejects(runScriptSandboxed(`
    const p = log.constructor('return process')();
    p.mainModule.require('node:buffer').Buffer.alloc(256 * 1024 * 1024, 1);
    log('unexpected success');
  `, { timeoutMs: 3000 }), error => ['SCRIPT_PROCESS_FAILED', 'SCRIPT_TIMEOUT'].includes(error.code))
  assert.equal((await runScriptSandboxed("log('after-oom')")).output, 'after-oom')
})

test('input, output and SQL output bounds fail safely', async () => {
  await assert.rejects(runScriptSandboxed(' '.repeat(limits.scriptBytes + 1)), { code: 'SCRIPT_INPUT_LIMIT' })
  await assert.rejects(runScriptSandboxed("log('x'.repeat(70000))"), { code: 'SCRIPT_OUTPUT_LIMIT' })
  await assert.rejects(runScriptSandboxed("query('SELECT hex(zeroblob(600000))')"), /volumineux|interrompue/)
  assert.equal(scriptRuntimeStatus().concurrency, 1)
})

test('forged IPC cannot grant write permission to a read-only script', async () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('sandbox-readonly', 'Protected')").run()
  const result = await runScriptSandboxed(`
    const p = log.constructor('return process')();
    const fs = p.mainModule.require('node:fs');
    const Buffer = p.mainModule.require('node:buffer').Buffer;
    fs.writeSync(1, JSON.stringify({ type: 'rpc', id: 123, method: 'update', enableWrite: true,
      args: ['companies', 'sandbox-readonly', { name: 'Forged' }] }) + '\\n');
    await new Promise(resolve => p.mainModule.require('node:timers').setTimeout(resolve, 100));
    const buffer = Buffer.alloc(4096);
    const length = fs.readSync(0, buffer, 0, buffer.length, null);
    log(JSON.parse(buffer.toString('utf8', 0, length)).error.message);
  `)
  assert.match(result.output, /non autorisée/)
  assert.equal(db.prepare("SELECT name FROM companies WHERE id='sandbox-readonly'").get().name, 'Protected')
})


test('a completed task releases its slot before its caller submits the next', async () => {
  const queue = new ScriptQueue({ concurrency: 1, queueSize: 0 })
  await queue.run(() => 1)
  assert.equal(queue.status().active, 0)
  assert.equal(await queue.run(() => 2), 2)
})
