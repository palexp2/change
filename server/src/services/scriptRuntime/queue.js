import { AsyncResource } from 'node:async_hooks'
import { runtimeError } from './config.js'

// FIFO, bounded in count and wait time. Each task keeps its caller's async context.
export class ScriptQueue {
  constructor({ concurrency = 1, queueSize = 50, queueTimeoutMs = 60000 } = {}) {
    Object.assign(this, { concurrency, queueSize, queueTimeoutMs })
    this.waiting = []
    this.active = new Set()
    this.closed = false
    this.completed = 0
    this.failed = 0
  }
  status() {
    return { active: this.active.size, queued: this.waiting.length, concurrency: this.concurrency,
      queueCapacity: this.queueSize, queueTimeoutMs: this.queueTimeoutMs, closed: this.closed,
      completed: this.completed, failed: this.failed }
  }
  run(task, { signal } = {}) {
    if (this.closed) return Promise.reject(runtimeError('SCRIPT_SHUTDOWN', 'Exécuteur arrêté'))
    if (signal?.aborted) return Promise.reject(runtimeError('SCRIPT_CANCELLED', 'Script annulé'))
    if (this.active.size >= this.concurrency && this.waiting.length >= this.queueSize) {
      return Promise.reject(runtimeError('SCRIPT_QUEUE_FULL', 'File des scripts pleine'))
    }
    return new Promise((resolve, reject) => {
      const entry = { task: AsyncResource.bind(task), resolve, reject, controller: new AbortController() }
      entry.cancel = () => {
        if (this.active.has(entry)) return entry.controller.abort()
        const index = this.waiting.indexOf(entry)
        if (index < 0) return
        this.waiting.splice(index, 1)
        entry.cleanup()
        reject(runtimeError('SCRIPT_CANCELLED', 'Script annulé'))
      }
      entry.cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.cancel) }
      signal?.addEventListener('abort', entry.cancel, { once: true })
      if (this.active.size < this.concurrency) this.start(entry)
      else {
        this.waiting.push(entry)
        entry.timer = setTimeout(() => {
          const index = this.waiting.indexOf(entry)
          if (index < 0) return
          this.waiting.splice(index, 1)
          entry.cleanup()
          reject(runtimeError('SCRIPT_QUEUE_TIMEOUT', 'Délai maximal dans la file dépassé'))
        }, this.queueTimeoutMs)
      }
    })
  }
  start(entry) {
    clearTimeout(entry.timer)
    this.active.add(entry)
    const release = () => {
      entry.cleanup()
      this.active.delete(entry)
      if (!this.closed && this.waiting.length) this.start(this.waiting.shift())
    }
    Promise.resolve().then(() => entry.task(entry.controller.signal)).then(value => {
      this.completed++
      release()
      entry.resolve(value)
    }, error => {
      this.failed++
      release()
      entry.reject(error)
    })
  }
  shutdown() {
    this.closed = true
    for (const entry of this.waiting.splice(0)) {
      entry.cleanup()
      entry.reject(runtimeError('SCRIPT_SHUTDOWN', 'Exécuteur arrêté'))
    }
    for (const entry of this.active) entry.controller.abort()
  }
}
