// Le protocole de fil du canal temps réel — sur un VRAI serveur WebSocket, avec
// de VRAIS clients, sans toucher à la base.
//
// Ce qui est vérifié tient en une phrase, mais c'est la phrase qui a coûté cher :
// un navigateur abonné à PLUSIEURS canaux visés par le même message doit le
// recevoir une fois, tagué avec TOUS les canaux concernés. Une fiche s'ouvre
// toujours en panneau latéral par-dessus sa liste (règle de design) : le
// navigateur écoute alors `orders:list` ET `order:<id>`. Tant que le message
// n'était tagué qu'avec le premier canal trouvé, le handler de la fiche ne
// tournait jamais — la fiche ouverte ne se mettait plus à jour en direct.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import { JWT_SECRET } from '../config/secrets.js'

process.env.REALTIME_ENABLED = 'true'
const { createRealtimeServer, emit } = await import('./realtime.js')

// Un client authentifié, abonné aux canaux demandés, qui collecte ses messages.
async function client(port, channels) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/erp/ws`)
  const received = []
  await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: jwt.sign({ id: 'u-test' }, JWT_SECRET, { algorithm: 'HS256' }) })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth:success') return resolve()
      if (msg.type === 'subscribed') return
      received.push(msg)
    })
  })
  let acks = 0
  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'subscribed' && ++acks === channels.length) resolve()
    })
    for (const ch of channels) ws.send(JSON.stringify({ type: 'subscribe', channel: ch }))
  })
  return { ws, received }
}

test('emit : un message, tous les canaux auxquels la socket est abonnée', async (t) => {
  const http = createServer()
  createRealtimeServer(http)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port

  // Le navigateur d'Antoine : la liste des commandes ET la fiche ouverte.
  const antoine = await client(port, ['orders:list', 'order:42'])
  // Celui de Michel : seulement la liste.
  const michel = await client(port, ['orders:list'])
  // Celui d'Émilie : une autre page, qui ne doit rien recevoir.
  const emilie = await client(port, ['contact:list'])

  t.after(() => {
    for (const c of [antoine, michel, emilie]) c.ws.close()
    http.close()
  })

  emit(['orders:list', 'order:42'], { type: 'order:updated', payload: { id: '42' }, source: 'airtable', fields: ['status'] })
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.equal(antoine.received.length, 1, 'une seule copie, même abonné deux fois')
  assert.deepEqual(antoine.received[0].channels, ['orders:list', 'order:42'])
  assert.equal(antoine.received[0].channel, 'orders:list', '`channel` reste le premier canal (repli)')
  assert.equal(antoine.received[0].source, 'airtable', "l'origine de l'écriture voyage avec le message")
  assert.deepEqual(antoine.received[0].fields, ['status'], 'les colonnes modifiées aussi')

  assert.deepEqual(michel.received.map(m => m.channels), [['orders:list']])
  assert.deepEqual(emilie.received, [], 'un canal non demandé ne reçoit rien')
})
