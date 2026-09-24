function bounded(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: entier requis entre ${min} et ${max}`)
  return value
}
export const limits = Object.freeze({
  memoryMb: bounded('SCRIPT_MEMORY_MB', 128, 96, 512),
  timeoutMs: bounded('SCRIPT_TIMEOUT_MS', 10000, 100, 30000),
  concurrency: bounded('SCRIPT_CONCURRENCY', 1, 1, 4),
  queueSize: bounded('SCRIPT_QUEUE_SIZE', 50, 0, 100),
  queueTimeoutMs: bounded('SCRIPT_QUEUE_TIMEOUT_MS', 60000, 100, 300000),
  scriptBytes: 64 * 1024,
  inputBytes: 1024 * 1024,
  outputBytes: 64 * 1024,
  rpcBytes: 1024 * 1024,
  operations: 100,
})
export function runtimeError(code, message) {
  return Object.assign(new Error(message), { code })
}
