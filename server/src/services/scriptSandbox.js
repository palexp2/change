import db from '../db/database.js'
import { sendEmail as gmailSendEmail } from './gmail.js'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { limits, runtimeError } from './scriptRuntime/config.js'
import { ScriptQueue } from './scriptRuntime/queue.js'
import { executeSandbox } from './scriptRuntime/process.js'
import { scriptFetch } from './scriptRuntime/network.js'

// The security boundary is the Linux sandbox + cgroup, NOT node:vm.
// Guests have no app filesystem, credentials, network or direct SQLite access.
// Tables a triggered script may write to. Mirrors the fieldRuleWatcher's watched
// set. Anything outside this set is rejected by update().
export const WRITABLE_TABLES = new Set([
  'factures', 'products', 'orders', 'shipments', 'companies', 'contacts', 'serial_numbers',
])

export const READABLE_TABLES = new Set([
  ...WRITABLE_TABLES, 'tickets', 'projects', 'order_items', 'return_items', 'returns',
  'purchases', 'achats_fournisseurs', 'sale_receipts', 'adresses', 'tasks',
  'stock_movements', 'bom_items',
])
const queue = new ScriptQueue(limits)
const queryWorker = fileURLToPath(new URL('./scriptRuntime/database.py', import.meta.url))
export function scriptRuntimeStatus() {
  return { ...queue.status(), memoryMb: limits.memoryMb, timeoutMs: limits.timeoutMs,
    isolation: 'linux-namespaces-cgroup', queryRows: 1000, queryTimeoutMs: 1000 }
}
export function shutdownScriptRuntime() { queue.shutdown() }

function databaseOperation(method, args, tables, allowTriggerWrite, signal) {
  const request = JSON.stringify({ method, args, tables: [...tables], allowTriggerWrite })
  if (Buffer.byteLength(request) > 128 * 1024) throw new Error('Requête SQL trop volumineuse')
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/prlimit', ['--as=67108864', '--cpu=2', '--core=0',
      '/usr/bin/python3', '-I', queryWorker, db.name], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, signal, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: limits.rpcBytes,
    }, (error, stdout) => {
      if (error) return reject(new Error('Requête interrompue : limite de temps ou mémoire'))
      try {
        const reply = JSON.parse(stdout)
        if (reply.error) return reject(new Error(reply.error))
        resolve(reply.value)
      } catch { reject(new Error('Réponse SQL invalide')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(request)
  })
}

/** Existing synchronous query()/update() contract is preserved by the IPC bridge.
 * timeoutMs may shorten the configured wall deadline, never increase it.
 * Queue admission precedes creating any process or side effect.
 */
export async function runScriptSandboxed(script, {
  row = null, trigger = {}, enableWrite = false, allowTriggerWrite = false,
  timeoutMs = limits.timeoutMs, params = null, request = null,
  writableTables = WRITABLE_TABLES, signal, onFetch,
} = {}) {
  if (typeof script !== 'string' || Buffer.byteLength(script) > limits.scriptBytes) throw runtimeError('SCRIPT_INPUT_LIMIT', 'Script trop volumineux')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Délai de script invalide')
  const data = { row, trigger, params, ...(request ? { request } : {}) }
  if (Buffer.byteLength(JSON.stringify(data)) > limits.inputBytes) throw runtimeError('SCRIPT_INPUT_LIMIT', 'Données du script trop volumineuses')
  // Snapshot inputs/permissions now, so queued callers cannot mutate them later.
  const job = JSON.parse(JSON.stringify({ script, data, enableWrite: enableWrite === true, timeoutMs: Math.min(timeoutMs, limits.timeoutMs) }))
  const tables = new Set([...writableTables].filter(table => READABLE_TABLES.has(table)))
  return queue.run(async jobSignal => {
    return executeSandbox(job, { signal: jobSignal, rpc: async (method, args, operationSignal) => {
      operationSignal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(args)) > 128 * 1024) throw new Error('Arguments trop volumineux')
      if (method === 'query') return databaseOperation('query', args, READABLE_TABLES, false, operationSignal)
      if (method === 'update' && job.enableWrite) return databaseOperation('update', args, tables, allowTriggerWrite === true, operationSignal)
      if (method === 'fetch') {
        // onFetch : l'appelant relève le code HTTP de chaque appel (historique).
        const reply = await scriptFetch(args[0], args[1], operationSignal)
        onFetch?.(reply)
        return reply
      }
      if (method === 'sendEmail') {
        const [to, subject, html] = args
        const allowed = (process.env.SCRIPT_EMAIL_RECIPIENTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        if (typeof to !== 'string' || !allowed.includes(to.toLowerCase()) || typeof subject !== 'string' || subject.length > 200 || typeof html !== 'string' || html.length > 16384) throw new Error('Envoi courriel non autorisé')
        await gmailSendEmail(to, subject, html)
        return null
      }
      throw new Error('Opération du script non autorisée')
    } })
  }, { signal })
}
