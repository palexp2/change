// In-memory sync state tracker
// { [key]: { running, startedAt, endedAt, error } }
const state = {}

export function syncStart(key) {
  state[key] = { running: true, startedAt: new Date().toISOString(), endedAt: null, error: null }
}

export function syncEnd(key, error = null) {
  if (state[key]) {
    state[key] = { running: false, startedAt: state[key].startedAt, endedAt: new Date().toISOString(), error }
  }
}

export function getStatus() {
  return state
}

// Wrap an async sync function with automatic state tracking
export function tracked(key, fn) {
  syncStart(key)
  return fn()
    .then(() => syncEnd(key, null))
    .catch(err => { syncEnd(key, err.message); throw err })
}
