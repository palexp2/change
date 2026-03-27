// In-memory sync state tracker per tenant
// { [tenantId]: { [key]: { running, startedAt, endedAt, error } } }
const state = new Map()

function getOrInit(tenantId) {
  if (!state.has(tenantId)) state.set(tenantId, {})
  return state.get(tenantId)
}

export function syncStart(tenantId, key) {
  const s = getOrInit(tenantId)
  s[key] = { running: true, startedAt: new Date().toISOString(), endedAt: null, error: null }
}

export function syncEnd(tenantId, key, error = null) {
  const s = getOrInit(tenantId)
  if (s[key]) {
    s[key] = { running: false, startedAt: s[key].startedAt, endedAt: new Date().toISOString(), error }
  }
}

export function getStatus(tenantId) {
  return state.get(tenantId) || {}
}

// Wrap an async sync function with automatic state tracking
export function tracked(tenantId, key, fn) {
  syncStart(tenantId, key)
  return fn()
    .then(() => syncEnd(tenantId, key, null))
    .catch(err => { syncEnd(tenantId, key, err.message); throw err })
}
