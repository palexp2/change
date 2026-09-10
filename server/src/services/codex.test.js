import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { normalizeCodexUsage, readCodexLimits } from './codexUsage.js'
import { codexArgs, execCommand } from './agentEngine.js'
import { codexEvents } from './codexEvents.js'
import { CLAUDE_MODELS, KNOWN_MODELS, noteModelLimit, resetModelLimits, resolveModel } from './agentModel.js'

test('Codex quotas preserve actual window duration and absent windows', () => {
  const usage = normalizeCodexUsage({ rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null,
  } } })
  assert.equal(usage.available, true)
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].label, 'Semaine')
  assert.equal(usage.windows[0].utilizationPct, 5)
  assert.equal(usage.windows[0].resetsAt, '2027-01-15T08:00:00.000Z')
  assert.equal(normalizeCodexUsage({}).available, false)
  assert.equal(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: null } } }).windows.length, 0)
})

function rpcProcess({ fail = false, silent = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.kill = () => { child.killed = true }
  child.requests = []
  child.stdin = new Writable({ write(data, _, callback) {
    const request = JSON.parse(String(data))
    child.requests.push(request)
    if (request.id && !silent) queueMicrotask(() => child.stdout.write(JSON.stringify({
      id: request.id,
      ...(fail ? { error: { message: 'private error' } } : { result: request.id === 1 ? {} : { rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 },
      } } }),
    }) + '\n'))
    callback()
  } })
  return child
}

test('Codex quota RPC initializes, reads only quotas, and closes the child', async () => {
  const child = rpcProcess()
  const usage = await readCodexLimits({ spawnProcess: () => child })
  assert.deepEqual(child.requests.map(r => r.method), ['initialize', 'initialized', 'account/rateLimits/read'])
  assert.equal(usage.windows[0].utilizationPct, 100)
  assert.equal(child.killed, true)
})

test('quota RPC errors and timeouts close the child without returning private errors', async () => {
  for (const options of [{ fail: true }, { silent: true }]) {
    const child = rpcProcess(options)
    await assert.rejects(readCodexLimits({ spawnProcess: () => child, timeoutMs: 10 }), /rpc-error|timeout/)
    assert.equal(child.killed, true)
  }
})

test('Codex execution uses its own CLI, preserves resume, and restricts questions to read-only', () => {
  const args = codexArgs({ readOnly: true, resumeSessionId: 'thread-1' })
  assert.ok(args.includes('sandbox_mode="read-only"'))
  assert.ok(args.includes('approval_policy="never"'))
  assert.ok(args.includes('resume'))
  assert.ok(args.includes('thread-1'))
  const cmd = execCommand({ model: 'codex', tools: 'Bash,Read,Write,Edit', taskId: 't', promptFile: '/tmp/p', logFile: '/tmp/l', codeFile: '/tmp/c', pidFile: '/tmp/pid' })
  assert.match(cmd, /codex-exec\.mjs/)
  assert.match(cmd, /'write'/)
  assert.doesNotMatch(cmd, /--model "codex"|--allowedTools/)
  assert.ok(codexArgs().includes('sandbox_mode="workspace-write"'))
  // Une question ne touche à rien : ni réseau, ni racines hors du repo.
  assert.ok(!codexArgs({ readOnly: true }).some(a => String(a).startsWith('sandbox_workspace_write.')))
})

// La finition d'une tâche (redémarrage PM2, appel de l'API locale, npm) échouait
// tant que le bac à sable ne laissait sortir ni le réseau ni l'écriture vers ~/.pm2.
test('une exécution Codex peut redémarrer PM2 et joindre l\'API locale', () => {
  const args = codexArgs()
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'))
  const roots = args.find(a => String(a).startsWith('sandbox_workspace_write.writable_roots='))
  assert.ok(roots, 'les racines accessibles en écriture doivent être déclarées')
  assert.match(roots, /\/home\/ec2-user\/\.pm2/)
})

test('Codex transcript keeps text, sessions, touched files and failures', () => {
  assert.equal(codexEvents({ type: 'thread.started', thread_id: 't' })[0].session_id, 't')
  assert.equal(codexEvents({ type: 'item.completed', item: { type: 'agent_message', text: 'Réponse' } }, 't')[0].message.content[0].text, 'Réponse')
  const file = codexEvents({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js' }] } })[0]
  assert.equal(file.message.content[0].input.file_path, 'a.js')
  assert.equal(codexEvents({ type: 'turn.failed', error: { message: 'Quota' } })[0].is_error, true)
})

test('Claude account exhaustion does not exhaust Codex and vice versa', () => {
  resetModelLimits()
  assert.ok(KNOWN_MODELS.includes('codex'))
  noteModelLimit(CLAUDE_MODELS, { resetAt: Date.now() + 60000 })
  assert.equal(resolveModel('fable'), null)
  assert.equal(resolveModel('codex'), 'codex')
  resetModelLimits()
  noteModelLimit('codex', { resetAt: Date.now() + 60000 })
  assert.equal(resolveModel('fable'), 'fable')
  assert.equal(resolveModel('codex'), null)
  resetModelLimits()
})
