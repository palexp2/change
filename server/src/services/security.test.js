import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import db from '../db/database.js'
import { initChangeLog } from '../db/changeLog.js'
import { initTestDb, createTestUser, buildTestApp, listen, apiFetch } from '../test-helpers/testApp.js'
import { issueSession, verifySession } from './sessionSecurity.js'
import { JWT_SECRET } from '../config/secrets.js'
import { requireAuth } from '../middleware/auth.js'
import { makeLoginRateLimit } from '../middleware/loginRateLimit.js'
import { createOAuthState, consumeOAuthState } from './oauthState.js'
import { filterCachedSpecs, canReceiveChannel } from './dataAccess.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'
import { up as encryptOAuth } from '../db/migrations/077-encrypt-oauth-tokens.js'
import automations from '../routes/automations.js'
import connectors from '../routes/connectors.js'
import bootstrap from '../routes/bootstrap.js'
import { createRealtimeServer, emit } from './realtime.js'

initTestDb()
initChangeLog()

test('sessions: expiry, deleted/disabled user, role changes and password revocation', () => {
  const { id, token } = createTestUser()
  assert.equal(verifySession(token).role, 'admin')
  const payload = jwt.decode(token)
  assert.equal(payload.exp - payload.iat, 10 * 365.25 * 24 * 3600)
  db.prepare("UPDATE users SET role='rh' WHERE id=?").run(id)
  assert.equal(verifySession(token).role, 'rh')
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(id)
  assert.throws(() => verifySession(token))
  db.prepare("UPDATE users SET active=1, password_hash='changed' WHERE id=?").run(id)
  assert.throws(() => verifySession(token))
  const fresh = issueSession(db.prepare('SELECT * FROM users WHERE id=?').get(id))
  assert.equal(verifySession(fresh).id, id)
  db.prepare('DELETE FROM users WHERE id=?').run(id)
  assert.throws(() => verifySession(fresh))
  assert.throws(() => verifySession(jwt.sign({ id, role: 'admin' }, JWT_SECRET)))
})

test('OAuth state: browser binding, provider, replay and revoked session', () => {
  const { token } = createTestUser()
  const req = { headers: { authorization: `Bearer ${token}` }, query: {}, secure: true }
  const cookies = {}
  const res = { cookie(k, v, options) { cookies[k] = v; assert.equal(options.httpOnly, true); assert.equal(options.secure, true) }, clearCookie() {} }
  const state = createOAuthState(req, res, 'airtable', { verifier: 'private-pkce', adminOnly: true })
  assert.ok(!state.includes('private-pkce'))
  req.query.state = state
  assert.throws(() => consumeOAuthState(req, res, 'airtable'))
  req.headers.cookie = `boreal_oauth_airtable=${cookies.boreal_oauth_airtable}`
  assert.throws(() => consumeOAuthState(req, res, 'google'))
  assert.equal(consumeOAuthState(req, res, 'airtable').verifier, 'private-pkce')
  assert.throws(() => consumeOAuthState(req, res, 'airtable'))
  const second = createOAuthState(req, res, 'airtable', { adminOnly: true })
  req.headers.cookie = `boreal_oauth_airtable=${cookies.boreal_oauth_airtable}`
  req.query.state = second
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(jwt.decode(token).id)
  assert.throws(() => consumeOAuthState(req, res, 'airtable'))
})

test('encryption round trip, tamper rejection and migration idempotence', () => {
  const encrypted = encryptCredentials('dummy-oauth-token')
  assert.notEqual(encrypted, 'dummy-oauth-token')
  assert.equal(decryptCredentials(encrypted), 'dummy-oauth-token')
  const [iv, tag, cipher] = encrypted.split(':')
  assert.throws(() => decryptCredentials(`${iv}:${'0'.repeat(32)}:${cipher}`))
  assert.ok(tag)
  const id = randomUUID()
  db.prepare('INSERT INTO connector_oauth (id, connector, account_key, access_token, refresh_token) VALUES (?,?,?,?,?)').run(id, 'google', id, 'dummy-access', 'dummy-refresh')
  encryptOAuth(db); encryptOAuth(db)
  const row = db.prepare('SELECT * FROM connector_oauth WHERE id=?').get(id)
  assert.notEqual(row.refresh_token, 'dummy-refresh')
  assert.equal(decryptCredentials(row.refresh_token), 'dummy-refresh')
})

test('rate limiter blocks account and IP independently and expires', () => {
  let time = 0
  const limit = makeLoginRateLimit({ now: () => time, max: 2, windowMs: 1000 })
  let allowed = 0, status
  const res = { setHeader() {}, status(code) { status = code; return this }, json() {} }
  const call = (ip, email) => limit({ ip, body: { email } }, res, () => allowed++)
  call('one', 'a'); call('two', 'a'); call('three', 'a')
  assert.equal(status, 429); assert.equal(allowed, 2)
  call('one', 'b'); call('one', 'c'); assert.equal(allowed, 3)
  time = 1001; call('one', 'a'); assert.equal(allowed, 4)
})

test('HTTP rejects non-admin scripts/connectors and excludes HR snapshot/delta', async t => {
  const ordinary = createTestUser({ role: 'user' })
  const admin = createTestUser()
  const app = buildTestApp({ '/api/automations': automations, '/api/connectors': connectors, '/api/bootstrap': bootstrap })
  const { server, base } = await listen(app)
  t.after(() => server.close())
  for (const [method, path, body] of [
    ['POST', '/api/automations', { name: 'should-not-exist', trigger_type: 'manual', script: 'log(1)' }],
    ['PUT', '/api/connectors/config/google', { client_secret: 'dummy' }],
    ['DELETE', '/api/connectors/accounts/nonexistent'],
  ]) assert.equal((await apiFetch(base, ordinary.token, method, path, body)).status, 403)
  const publicCallback = await fetch(base + '/api/connectors/google/callback?code=dummy&state=forged')
  assert.equal(publicCallback.status, 400)
  const snap = await apiFetch(base, ordinary.token, 'GET', '/api/bootstrap')
  assert.equal(snap.status, 200)
  for (const name of ['employees', 'paies', 'vacations', 'timesheets']) assert.ok(!(name in snap.body.tables))
  const delta = await apiFetch(base, ordinary.token, 'GET', '/api/bootstrap/delta?since=' + encodeURIComponent(snap.body.snapshot_ts))
  assert.equal(delta.status, 200, JSON.stringify(delta.body))
  assert.equal(delta.body.columns_signature, snap.body.columns_signature)
  assert.notDeepEqual(filterCachedSpecs({ employees: {}, orders: {} }, { role: 'admin' }), filterCachedSpecs({ employees: {}, orders: {} }, { role: 'user' }))
  assert.equal((await apiFetch(base, admin.token, 'GET', '/api/automations')).status, 200)
})

test('private file middleware rejects anonymous HEAD requests', async t => {
  const app = express()
  app.use('/api/attachments', requireAuth, (_req, res) => res.send('private fixture'))
  const { server, base } = await listen(app)
  t.after(() => server.close())
  assert.equal((await fetch(base + '/api/attachments/fixture', { method: 'HEAD' })).status, 401)
  const { token } = createTestUser()
  assert.equal((await fetch(base + '/api/attachments/fixture', { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } })).status, 200)
})

test('WebSocket refuses HR subscriptions and stops delivery after revocation', async t => {
  process.env.REALTIME_ENABLED = 'true'
  const user = createTestUser({ role: 'user' })
  const http = createServer()
  const wss = createRealtimeServer(http)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/erp/ws`)
  t.after(() => { ws.terminate(); for (const socket of wss.clients) socket.terminate(); wss.close(); http.close() })
  await once(ws, 'open')
  let received = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'auth', token: user.token }))
  assert.equal(JSON.parse((await received)[0]).type, 'auth:success')
  assert.equal(canReceiveChannel({ role: 'user' }, 'employee:42'), false)
  received = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'subscribe', channel: 'orders:list' }))
  await received
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(user.id)
  const closed = once(ws, 'close')
  emit('orders:list', { type: 'order:updated', payload: { id: 'fixture' } })
  assert.equal((await closed)[0], 4002)
})
