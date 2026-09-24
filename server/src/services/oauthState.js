import { hasRole } from '../../../shared/roles.mjs'
import { randomBytes } from 'node:crypto'
import { verifySession } from './sessionSecurity.js'

// State and PKCE verifier never travel together. A callback must also carry the
// browser's HttpOnly nonce cookie. Restarting the process expires pending flows.
const pending = new Map()
const TTL = 10 * 60_000
const cookieName = provider => `boreal_oauth_${provider}`
const cookieOptions = req => ({ httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge: TTL })
export function createOAuthState(req, res, provider, data) {
  const now = Date.now()
  for (const [key, item] of pending) if (item.expires <= now) pending.delete(key)
  if (pending.size >= 1000) throw new Error('Too many pending OAuth requests')
  const state = randomBytes(32).toString('base64url')
  const binding = randomBytes(32).toString('base64url')
  const token = req.headers.authorization?.slice(7) || req.query.token
  pending.set(state, { provider, binding, token, data, expires: now + TTL })
  res.cookie(cookieName(provider), binding, cookieOptions(req))
  return state
}
export function consumeOAuthState(req, res, provider) {
  const state = req.query.state
  const item = typeof state === 'string' ? pending.get(state) : null
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')))
  if (!item || item.provider !== provider || item.expires <= Date.now() || cookies[cookieName(provider)] !== item.binding) {
    throw new Error('Invalid or expired OAuth state')
  }
  pending.delete(state)
  res.clearCookie(cookieName(provider), { ...cookieOptions(req), maxAge: undefined })
  const user = verifySession(item.token)
  if (item.data.adminOnly && !hasRole(user, 'admin')) throw new Error('Admin access required')
  return item.data
}
