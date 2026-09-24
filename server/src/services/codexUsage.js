import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { CODEX_BIN } from './agentEngine.js'

// Official local RPC: https://developers.openai.com/codex/app-server
// Only quota data leaves this service; credentials stay with the Codex CLI.
export function normalizeCodexUsage(result, now = Date.now()) {
  const snapshot = result?.rateLimitsByLimitId?.codex || result?.rateLimits
  const windows = ['primary', 'secondary'].flatMap(key => {
    const window = snapshot?.[key]
    if (!window || !Number.isFinite(window.usedPercent)) return []
    const mins = window.windowDurationMins
    const reset = Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null
    return [{
      key,
      label: mins === 10080 ? 'Semaine' : mins === 300 ? 'Fenêtre 5 h'
        : mins > 0 ? `Fenêtre ${mins % 60 ? `${mins} min` : `${mins / 60} h`}` : key === 'primary' ? 'Limite principale' : 'Limite secondaire',
      utilizationPct: Math.max(0, Math.min(100, window.usedPercent)),
      resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
    }]
  })
  return { available: windows.length > 0, windows, fetchedAt: new Date(now).toISOString(),
    error: windows.length ? null : 'Limites indisponibles pour ce compte Codex.' }
}

export function readCodexLimits({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      child.kill()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    const lines = createInterface({ input: child.stdout })
    const send = data => child.stdin.write(JSON.stringify(data) + '\n')
    child.on('error', error => finish(error))
    child.stdin.on('error', error => finish(error))
    child.on('close', () => finish(new Error('closed')))
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.id !== 1 && message.id !== 2) return
      if (message.error) return finish(new Error('rpc-error'))
      if (message.id === 1) {
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read' })
      } else finish(null, normalizeCodexUsage(message.result))
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'erp_usage', version: '1.0.0' } } })
  })
}

let cache = null
let expiresAt = 0
let pending = null
export async function getCodexUsage() {
  if (cache && Date.now() < expiresAt) return cache
  if (!pending) pending = readCodexLimits().then(value => { cache = value }).catch(() => {
    cache = { available: false, windows: [], fetchedAt: null,
      error: 'Quotas Codex indisponibles. Vérifiez la connexion du compte Codex sur le serveur.' }
  }).finally(() => { expiresAt = Date.now() + 60000; pending = null })
  await pending
  return cache
}

// Dernière lecture connue, sans relancer Codex (cf. peekClaudeUsage).
export function peekCodexUsage() { return cache }
