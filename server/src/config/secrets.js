import dotenv from 'dotenv'
import { randomBytes } from 'crypto'
dotenv.config()

const WEAK_DEFAULTS = new Set([
  'change-this-secret-in-production',
  'agent-internal-secret',
  'dev_fallback_key_32bytes_000000000000000000000000000000000',
])

function loadSecret(name, { minLength = 32, required = true } = {}) {
  const value = process.env[name]
  if (!value) {
    if (required) {
      console.error(`[secrets] CRITICAL: ${name} is not set. Server is running with degraded security.`)
    }
    return null
  }
  if (WEAK_DEFAULTS.has(value)) {
    console.error(`[secrets] CRITICAL: ${name} uses a known weak default value.`)
    return null
  }
  if (value.length < minLength) {
    console.error(`[secrets] WARNING: ${name} is shorter than ${minLength} chars (got ${value.length}).`)
  }
  return value
}

// Validated values — null if missing/weak. Caller must handle null gracefully
// (warn-only mode for now to avoid taking prod down on existing weak configs).
export const JWT_SECRET = loadSecret('JWT_SECRET', { minLength: 32 })
  ?? process.env.JWT_SECRET // fall through to whatever is set, even if weak
  ?? 'change-this-secret-in-production' // last-resort: keep legacy behavior
// AGENT_INTERNAL_SECRET: if missing, generate an ephemeral per-process secret so
// the agent task system keeps working without a hardcoded weak default. Both
// the route handler and the task runner import this same value, so they agree.
const _envAgentSecret = loadSecret('AGENT_INTERNAL_SECRET', { minLength: 32 })
let _ephemeralAgentSecret = null
if (!_envAgentSecret) {
  _ephemeralAgentSecret = randomBytes(32).toString('hex')
  console.warn('[secrets] AGENT_INTERNAL_SECRET not set — generated an ephemeral random secret (rotates on every restart). Set in .env for stability.')
}
export const AGENT_INTERNAL_SECRET = _envAgentSecret || _ephemeralAgentSecret
export const CONNECTOR_ENCRYPTION_KEY = loadSecret('CONNECTOR_ENCRYPTION_KEY', { minLength: 64 })
