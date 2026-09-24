import { rolesOf } from '../../../shared/roles.mjs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import db from '../db/database.js'
import { JWT_SECRET } from '../config/secrets.js'

// A password change invalidates every existing token, without storing the hash in it.
export function sessionStamp(user) {
  return createHmac('sha256', JWT_SECRET).update(`${user.id}:${user.password_hash}`).digest('hex')
}

export function issueSession(user) {
  return jwt.sign({ id: user.id, role: user.role, roles: rolesOf(user), employee_id: user.employee_id || null, name: user.name, session: sessionStamp(user) }, JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10y' })
}

export function verifySession(token) {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
  if (!payload.exp || typeof payload.id !== 'string' || typeof payload.session !== 'string') throw new Error('Invalid session')
  const user = db.prepare('SELECT id, role, roles, employee_id, name, active, password_hash FROM users WHERE id = ?').get(payload.id)
  if (!user || user.active !== 1) throw new Error('Inactive user')
  const expected = Buffer.from(sessionStamp(user))
  const actual = Buffer.from(payload.session)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Revoked session')
  return { id: user.id, role: user.role, roles: rolesOf(user), employee_id: user.employee_id || null, name: user.name }
}
