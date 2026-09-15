import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { CODEX_BIN, codexArgs } from '../src/services/agentEngine.js'
import { codexEvents } from '../src/services/codexEvents.js'

const [effort, mode, resumeSessionId] = process.argv.slice(2)
const child = spawn(CODEX_BIN, codexArgs({ effort, readOnly: mode !== 'write', resumeSessionId }), {
  stdio: ['inherit', 'pipe', 'inherit'],
})
let sessionId = null
let last = ''
let failed = false
const emit = evt => process.stdout.write(JSON.stringify(evt) + '\n')
createInterface({ input: child.stdout }).on('line', line => {
  try {
    const evt = JSON.parse(line)
    if (evt.thread_id) sessionId = evt.thread_id
    if (evt.type === 'turn.failed') failed = true
    if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') last = evt.item.text
    for (const mapped of codexEvents(evt, sessionId)) emit(mapped)
    if (evt.type === 'turn.completed') emit({ type: 'result', result: last, session_id: sessionId })
  } catch { process.stderr.write(line + '\n') }
})
child.on('error', () => { emit({ type: 'result', is_error: true, result: 'Impossible de démarrer Codex.' }); process.exitCode = 1 })
child.on('close', code => { process.exitCode = failed ? 1 : (code ?? 1) })
