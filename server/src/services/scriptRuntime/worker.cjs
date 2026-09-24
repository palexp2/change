// This process runs inside Linux namespaces and a memory-limited cgroup.
// node:vm is ONLY the scripting API here, never the security boundary.
const fs = require('node:fs')
const vm = require('node:vm')
const sleeper = new Int32Array(new SharedArrayBuffer(4))
let input = Buffer.alloc(0)
function readLine() {
  for (;;) {
    const newline = input.indexOf(10)
    if (newline >= 0) {
      const line = input.subarray(0, newline).toString('utf8')
      input = input.subarray(newline + 1)
      return JSON.parse(line)
    }
    const chunk = Buffer.allocUnsafe(8192)
    let length
    try { length = fs.readSync(0, chunk, 0, chunk.length, null) }
    catch (error) {
      if (error.code !== 'EAGAIN') throw error
      Atomics.wait(sleeper, 0, 0, 5)
      continue
    }
    if (!length) throw new Error('Exécuteur déconnecté')
    input = Buffer.concat([input, chunk.subarray(0, length)])
    if (input.length > 2 * 1024 * 1024) throw new Error('Message trop volumineux')
  }
}
function send(message) { fs.writeSync(1, JSON.stringify(message) + '\n') }
let sequence = 0
function rpc(method, args) {
  const id = ++sequence
  send({ type: 'rpc', id, method, args })
  const result = readLine()
  if (result.id !== id) throw new Error('Réponse RPC invalide')
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}
const job = readLine()
const log = (...args) => send({ type: 'log', text: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') })
const context = vm.createContext({
  log, console: { log },
  query: (...args) => rpc('query', args),
  fetch: async (...args) => rpc('fetch', args),
  sendEmail: async (...args) => rpc('sendEmail', args),
  ...(job.enableWrite ? { update: (...args) => {
    const changed = rpc('update', args)
    log(`✏️ update(${args[0]}, ${args[1]}) → ${changed} ligne(s)`)
    return changed
  } } : {}),
})
// Copy inputs into the guest realm, not host object references.
vm.runInContext(`Object.assign(globalThis, JSON.parse(${JSON.stringify(JSON.stringify(job.data))}))`, context)
if (job.data.params !== null) vm.runInContext('globalThis.respond = (status, body) => { globalThis.__response = { status: Number(status) || 200, body: body ?? null } }', context)
const keepAlive = setInterval(() => {}, 1000)
;(async () => {
  try {
    await vm.runInContext(`(async () => { ${job.script}\n })()`, context, { timeout: job.timeoutMs })
    const response = vm.runInContext('typeof __response === "undefined" ? null : __response', context, { timeout: 100 })
    send({ type: 'done', response })
  } catch (error) {
    send({ type: 'error', message: String(error?.message || error), code: error?.code })
  } finally {
    clearInterval(keepAlive)
    process.exit(0)
  }
})()
