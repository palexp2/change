import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execCommand, toollessSpec, streamSpec } from './agentEngine.js'

const BASE = {
  taskId: 't1', pidFile: '/tmp/pid', promptFile: '/tmp/prompt',
  logFile: '/tmp/log', codeFile: '/tmp/code',
}

test('execCommand : modèle, effort, reprise de session et hook de steering', () => {
  const cmd = execCommand({
    ...BASE, model: 'opus', effort: 'high',
    tools: 'Bash,Read', resumeSessionId: 'sess-1', settingsFile: '/s.json',
  })
  assert.match(cmd, /--model "opus"/)
  assert.match(cmd, /--effort "high"/)
  assert.match(cmd, /--resume "sess-1"/)
  assert.match(cmd, /--settings "\/s\.json"/)
  assert.match(cmd, /--allowedTools "Bash,Read"/)
  assert.match(cmd, /< "\/tmp\/prompt" > "\/tmp\/log" 2>&1; echo \$\? > "\/tmp\/code"/)
})

test('execCommand : le fichier PID est toujours écrit en premier', () => {
  assert.match(execCommand({ ...BASE }), /^printf '%s\\n%s\\n' "__SHELL_PID__" "t1" > "\/tmp\/pid"; /)
})

test('specs courtes : le modèle et l\'effort demandés arrivent au CLI', () => {
  assert.deepEqual(toollessSpec({ model: 'haiku', effort: 'low' }).args,
    ['-p', '--model', 'haiku', '--effort', 'low', '--tools', ''])
  const stream = streamSpec({ allowedTools: 'Read,Grep' })
  assert.ok(stream.args.includes('stream-json'))
  assert.ok(stream.args.includes('Read,Grep'))
})
