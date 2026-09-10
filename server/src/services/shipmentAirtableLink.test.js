// Colonne miroir « items expédiés » d'un envoi : elle se recalcule depuis
// order_items.shipment_id (la vérité locale de ce qui part dans le colis), et
// ne s'efface JAMAIS d'elle-même — un envoi né dans Airtable, dont Boréal ne
// connaît aucune assignation, garderait sinon une liste vide et se ferait délier
// ses articles au premier write-back.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-shipment-link-${process.pid}.db`)

const db = (await import('../db/database.js')).default

db.exec(`CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, airtable_id TEXT, items_expedies TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY, airtable_id TEXT, shipment_id TEXT
)`)

const { refreshShipmentItemsMirror, shipmentItemLinkKeys } =
  await import('./shipmentAirtableLink.js')

function seed(shipmentId, items) {
  db.prepare('DELETE FROM order_items').run()
  db.prepare('DELETE FROM shipments').run()
  db.prepare('INSERT INTO shipments (id, items_expedies) VALUES (?, ?)').run(shipmentId, 'recANCIEN')
  for (const [id, airtableId, sid] of items) {
    db.prepare('INSERT INTO order_items (id, airtable_id, shipment_id) VALUES (?, ?, ?)')
      .run(id, airtableId, sid)
  }
}

const mirror = (id) => db.prepare('SELECT items_expedies FROM shipments WHERE id=?').get(id).items_expedies

test('les articles assignés donnent leur record id Airtable, les autres leur id Boréal', () => {
  seed('s1', [['i1', 'recAAA', 's1'], ['i2', null, 's1'], ['i3', 'recCCC', 's2']])
  assert.deepEqual(shipmentItemLinkKeys('s1'), ['recAAA', 'i2'])

  const { keys, written } = refreshShipmentItemsMirror('s1')
  assert.deepEqual(keys, ['recAAA', 'i2'])
  assert.equal(written, true)
  // Tableau JSON : la forme que linkKeys/airtableLinkIds savent traduire en
  // [recXXX] pour un champ « linked record ».
  assert.deepEqual(JSON.parse(mirror('s1')), ['recAAA', 'i2'])
})

test('aucun article assigné : la colonne miroir n’est pas touchée', () => {
  seed('s1', [['i1', 'recAAA', 's2']])
  const { keys, written } = refreshShipmentItemsMirror('s1')
  assert.deepEqual(keys, [])
  assert.equal(written, false)
  assert.equal(mirror('s1'), 'recANCIEN')
})

test('allowEmpty : le vide décidé par l’utilisateur délie côté Airtable', () => {
  seed('s1', [['i1', 'recAAA', 's2']])
  const { written } = refreshShipmentItemsMirror('s1', { allowEmpty: true })
  assert.equal(written, true)
  assert.deepEqual(JSON.parse(mirror('s1')), [])
})
