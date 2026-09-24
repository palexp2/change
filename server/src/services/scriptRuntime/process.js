import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { limits, runtimeError } from './config.js'

const workerPath = fileURLToPath(new URL('./worker.cjs', import.meta.url))
export function systemdEnv() {
  const runtime = `/run/user/${process.getuid()}`
  return { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, LANG: 'C.UTF-8' }
}
export function sandboxCommand(unit, timeoutMs) {
  const node = realpathSync(process.execPath)
  if (!node.startsWith('/usr/')) throw new Error('Le runtime Node doit être installé sous /usr')
  return [
    '--user', '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${unit}`,
    `--property=MemoryMax=${limits.memoryMb}M`, '--property=MemorySwapMax=0',
    '--property=TasksMax=16', '--property=CPUQuota=100%', '--property=OOMPolicy=kill',
    '--property=LimitCORE=0', '--property=LimitFSIZE=1048576', '--property=NoNewPrivileges=yes',
    '--property=KillMode=control-group', '--property=TimeoutStopSec=1s',
    `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}s`,
    '/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr/lib64', '/usr/lib64', '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', node, node, '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/lib', '/lib',
    '--proc', '/proc', '--dev', '/dev', '--dir', '/sandbox', '--ro-bind', workerPath, '/sandbox/worker.cjs',
    '--size', '8388608', '--tmpfs', '/tmp', '--chdir', '/tmp', '--clearenv',
    '--setenv', 'LANG', 'C.UTF-8', '--remount-ro', '/',
    node, '--max-old-space-size=64', '/sandbox/worker.cjs',
  ]
}

// All frames from the sandbox are hostile. No filenames, SQL permissions, limits
// or execution options supplied by the child are ever trusted by the host.
export function executeSandbox(job, { signal, rpc }) {
  return new Promise((resolve, reject) => {
    const unit = `boreal-script-${randomUUID()}.service`
    const child = spawn('/usr/bin/systemd-run', sandboxCommand(unit, job.timeoutMs), {
      stdio: ['pipe', 'pipe', 'pipe'], env: systemdEnv(),
    })
    const controller = new AbortController()
    let stopped = false, finished = false, result, failure, pending = false, operations = 0
    let outputBytes = 0, totalBytes = 0, buffer = '', stderr = ''
    const logs = []
    const decoder = new StringDecoder('utf8')
    const stop = error => {
      if (stopped) return
      stopped = true
      failure ||= error
      controller.abort()
      // Kill every descendant, not just systemd-run (which is only the client).
      execFile('/usr/bin/systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
        { env: systemdEnv(), timeout: 2000 }, () => {})
      child.stdin.destroy()
    }
    const onAbort = () => stop(runtimeError('SCRIPT_CANCELLED', 'Script annulé'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop(runtimeError('SCRIPT_TIMEOUT', `Durée maximale dépassée (${job.timeoutMs} ms)`)), job.timeoutMs)
    // systemd RuntimeMaxSec is the independent backstop, including parent death.
    const reapTimer = setTimeout(() => { stop(runtimeError('SCRIPT_TIMEOUT', 'Exécuteur indisponible')); child.kill('SIGKILL') }, job.timeoutMs + 4000)
    const complete = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer); clearTimeout(reapTimer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (error) { error.partialOutput = logs.join('\n') || null; reject(error) }
      else resolve({ output: logs.join('\n') || null, logs, response: result.response ?? null })
    }
    child.on('error', error => complete(runtimeError('SCRIPT_ISOLATION_UNAVAILABLE', `Isolation indisponible : ${error.message}`)))
    child.stdin.on('error', () => {})
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096) })
    child.stdout.on('data', chunk => {
      if (stopped) return
      totalBytes += chunk.length
      if (totalBytes > limits.rpcBytes * 2) return stop(runtimeError('SCRIPT_OUTPUT_LIMIT', 'Sortie du script trop volumineuse'))
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > limits.rpcBytes) return stop(runtimeError('SCRIPT_OUTPUT_LIMIT', 'Message du script trop volumineux'))
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0 && !stopped) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { return stop(runtimeError('SCRIPT_PROTOCOL', 'Message du script invalide')) }
        if (!message || typeof message !== 'object' || result) return stop(runtimeError('SCRIPT_PROTOCOL', 'Protocole du script invalide'))
        if (message.type === 'log') {
          if (typeof message.text !== 'string') return stop(runtimeError('SCRIPT_PROTOCOL', 'Journal invalide'))
          outputBytes += Buffer.byteLength(message.text) + 1
          if (outputBytes > limits.outputBytes) return stop(runtimeError('SCRIPT_OUTPUT_LIMIT', 'Journal du script trop volumineux'))
          logs.push(message.text)
        } else if (message.type === 'rpc') {
          if (pending || ++operations > limits.operations || !Number.isSafeInteger(message.id) || !Array.isArray(message.args)) {
            return stop(runtimeError('SCRIPT_RPC_LIMIT', 'Limite des opérations du script dépassée'))
          }
          pending = true
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted()
            return rpc(message.method, message.args, controller.signal)
          }).then(value => ({ id: message.id, value }), error => ({ id: message.id, error: { message: String(error.message).slice(0, 500), code: error.code } }))
            .then(reply => {
              pending = false
              if (stopped || finished || result) return
              const data = JSON.stringify(reply)
              if (Buffer.byteLength(data) > limits.rpcBytes) return stop(runtimeError('SCRIPT_OUTPUT_LIMIT', 'Résultat trop volumineux'))
              child.stdin.write(data + '\n')
            }).catch(() => stop(runtimeError('SCRIPT_PROTOCOL', 'Réponse du courtier invalide')))
        } else if (message.type === 'done') {
          if (pending) return stop(runtimeError('SCRIPT_PROTOCOL', 'Opération encore en cours'))
          if (Buffer.byteLength(line) > limits.outputBytes) return stop(runtimeError('SCRIPT_OUTPUT_LIMIT', 'Réponse trop volumineuse'))
          result = message
        } else if (message.type === 'error') {
          stop(runtimeError(message.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'SCRIPT_TIMEOUT' : 'SCRIPT_FAILED', String(message.message).slice(0, 500)))
        } else stop(runtimeError('SCRIPT_PROTOCOL', 'Message du script inconnu'))
      }
    })
    child.on('close', code => {
      const error = failure || (code !== 0 || !result
        ? runtimeError('SCRIPT_PROCESS_FAILED', /memory|heap|oom/i.test(stderr)
          ? 'Script arrêté : limite mémoire dépassée' : 'Processus isolé arrêté ou isolation indisponible') : null)
      complete(error)
    })
    child.stdin.write(JSON.stringify(job) + '\n')
    if (signal?.aborted) onAbort()
  })
}
