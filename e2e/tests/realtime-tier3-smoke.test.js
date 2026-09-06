// Tier 3 smoke — validates the WS broadcast pipeline for a Tier 3 entity
// (activity_code). Same approach as the Tier 2 smoke: raw WebSocket client,
// no browser, exercise route → emitEntity → broadcast end-to-end.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const WebSocket = require('ws')

const BASE = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

function wsUrlFromHttp(httpUrl) {
  const u = new globalThis.URL(httpUrl)
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/erp/ws`
}

async function getToken() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  if (!r.ok) throw new Error(`login failed: ${r.status}`)
  return (await r.json()).token
}

async function authedSocket(token, channel) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlFromHttp(BASE))
    const messages = []
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString())
      messages.push(msg)
      if (msg.type === 'auth:success') ws.send(JSON.stringify({ type: 'subscribe', channel }))
    })
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })))
    ws.on('error', reject)
    setTimeout(() => resolve({ ws, messages }), 800)
  })
}

function waitForMessage(messages, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const found = messages.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('timeout waiting for message: ' + JSON.stringify(messages.slice(-2))))
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe('Realtime Tier 3 — smoke (activity_codes via WS)', () => {
  let token, ws, messages, codeId

  before(async () => {
    token = await getToken()
    const out = await authedSocket(token, 'activity_code:list')
    ws = out.ws
    messages = out.messages
  })

  after(async () => {
    if (codeId) {
      try {
        await fetch(`${BASE}/api/activity-codes/${codeId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {}
    }
    ws?.close()
  })

  test('POST /activity-codes → broadcast activity_code:created', async () => {
    const name = `RT-T3-WS-${Date.now()}`
    const r = await fetch(`${BASE}/api/activity-codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    })
    const code = await r.json()
    assert.ok(code.id, 'creation: ' + JSON.stringify(code))
    codeId = code.id

    const evt = await waitForMessage(messages, m => m.type === 'activity_code:created' && m.payload?.id === code.id)
    assert.equal(evt.payload.name, name)
  })

  test('PATCH /activity-codes/:id → broadcast activity_code:updated', async () => {
    if (!codeId) return
    const before = messages.length
    await fetch(`${BASE}/api/activity-codes/${codeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: 'updated by smoke test' }),
    })
    await waitForMessage(messages.slice(before), m => m.type === 'activity_code:updated' && m.payload?.id === codeId)
  })

  test('DELETE /activity-codes/:id → broadcast activity_code:deleted', async () => {
    if (!codeId) return
    const before = messages.length
    await fetch(`${BASE}/api/activity-codes/${codeId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await waitForMessage(messages.slice(before), m => m.type === 'activity_code:deleted' && m.payload?.id === codeId)
    codeId = null
  })
})
