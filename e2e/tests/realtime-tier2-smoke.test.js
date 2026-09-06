// Tier 2 smoke — validates emitEntity + WS pipeline for an achat fournisseur
// (Tier 2 entity). We don't go through a browser here — instead we connect a
// raw WebSocket client, subscribe to the channel, mutate via the HTTP API,
// and assert the broadcast lands. This exercises the full path
// (route → emitEntity → emit → WS broadcast) without depending on
// DataTable filter/grouping quirks that vary per saved view.

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
    setTimeout(() => resolve({ ws, messages }), 800) // give time to receive subscribed ack
  })
}

function waitForMessage(messages, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const found = messages.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('timeout waiting for message'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe('Realtime Tier 2 — smoke (achats fournisseurs via WS)', () => {
  let token, ws, messages, achatId

  before(async () => {
    token = await getToken()
    const out = await authedSocket(token, 'achat_fournisseur:list')
    ws = out.ws
    messages = out.messages
    // Sanity: subscribed event should be there.
    assert.ok(messages.some(m => m.type === 'subscribed' && m.channel === 'achat_fournisseur:list'),
      'no subscribed ack: ' + JSON.stringify(messages))
  })

  after(async () => {
    if (achatId) {
      try {
        await fetch(`${BASE}/api/achats-fournisseurs/${achatId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {}
    }
    ws?.close()
  })

  test('POST /achats-fournisseurs → broadcast achat_fournisseur:created', async () => {
    const ref = `RT-T2-WS-${Date.now()}`
    const r = await fetch(`${BASE}/api/achats-fournisseurs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'bill',
        date_achat: new Date().toISOString().slice(0, 10),
        vendor: 'RT Smoke',
        bill_number: ref,
        amount_cad: 50,
        total_cad: 50,
        currency: 'CAD',
      }),
    })
    const ach = await r.json()
    assert.ok(ach.id, 'creation: ' + JSON.stringify(ach))
    achatId = ach.id

    const evt = await waitForMessage(messages, m => m.type === 'achat_fournisseur:created' && m.payload?.id === ach.id)
    assert.equal(evt.payload.bill_number, ref, 'broadcast payload mismatch')
    assert.equal(evt.channel, 'achat_fournisseur:list')
  })

  test('PATCH /achats-fournisseurs/:id/status → broadcast achat_fournisseur:updated', async () => {
    if (!achatId) return
    const before = messages.length
    await fetch(`${BASE}/api/achats-fournisseurs/${achatId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: 'Brouillon' }),
    })
    await waitForMessage(messages.slice(before), m => m.type === 'achat_fournisseur:updated' && m.payload?.id === achatId)
  })

  test('DELETE /achats-fournisseurs/:id → broadcast achat_fournisseur:deleted', async () => {
    if (!achatId) return
    const before = messages.length
    await fetch(`${BASE}/api/achats-fournisseurs/${achatId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await waitForMessage(messages.slice(before), m => m.type === 'achat_fournisseur:deleted' && m.payload?.id === achatId)
    achatId = null
  })
})
