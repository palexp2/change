import '../test-helpers/testEnv.js'
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { qbGet, qbPost } from './quickbooks.js'

const originalFetch = globalThis.fetch
let writes = []

before(() => {
  initTestDb()
  db.prepare(`INSERT INTO connector_oauth (id, connector, account_key, access_token, metadata)
    VALUES ('qb-number-test', 'quickbooks', 'default', 'fake-token', '{"realm_id":"company-a"}')`).run()
})

beforeEach(() => {
  writes = []
  db.prepare('DELETE FROM qb_journal_sequences').run()
  db.prepare(`UPDATE connector_oauth SET metadata = '{"realm_id":"company-a"}' WHERE id = 'qb-number-test'`).run()
  globalThis.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    writes.push({ url: String(url), body })
    return new Response(JSON.stringify({ JournalEntry: { ...body, Id: String(writes.length) } }))
  }
})

after(() => { globalThis.fetch = originalFetch })

test('numérote les créations concurrentes et renvoie le numéro QB sans modifier le brouillon', async () => {
  const draft = { Line: [], PrivateNote: 'Test' }
  const results = await Promise.all(Array.from({ length: 25 }, () => qbPost('/journalentry', draft)))
  const numbers = results.map(r => r.JournalEntry.DocNumber)
  assert.equal(new Set(numbers).size, 25)
  assert.equal(numbers[0], 'ERP-JE-000001')
  assert.equal(numbers.at(-1), 'ERP-JE-000025')
  assert.equal(draft.DocNumber, undefined)
  // Une autre connexion lit le compteur durable, indépendamment du module JS.
  const reader = new Database(process.env.DATABASE_PATH, { readonly: true })
  try {
    assert.equal(reader.prepare('SELECT last_number FROM qb_journal_sequences WHERE realm_id = ?').get('company-a').last_number, 25)
  } finally { reader.close() }
})

test('numérote aussi les valeurs vides et les créations avec paramètres', async () => {
  for (const DocNumber of ['', '  ', null]) {
    await qbPost('/journalentry?operation=create', { Line: [], DocNumber })
  }
  assert.deepEqual(writes.map(w => w.body.DocNumber), ['ERP-JE-000001', 'ERP-JE-000002', 'ERP-JE-000003'])
})

test('préserve les numéros explicites et avance au-delà des numéros manuels de la série ERP', async () => {
  await qbPost('/journalentry', { DocNumber: 'CLOTURE-2026', Line: [] })
  await qbPost('/journalentry', { DocNumber: 'ERP-JE-000042', Line: [] })
  await qbPost('/journalentry', { DocNumber: 'ERP-JE-000010', Line: [] })
  await qbPost('/journalentry', { Line: [] })
  assert.deepEqual(writes.map(w => w.body.DocNumber), ['CLOTURE-2026', 'ERP-JE-000042', 'ERP-JE-000010', 'ERP-JE-000043'])
})

test('ne numérote pas les modifications, suppressions, lectures ou autres transactions', async () => {
  const update = { Id: '123', SyncToken: '0', Line: [] }
  await qbPost('/journalentry', update)
  await qbPost('/journalentry?operation=delete', { Id: '123', SyncToken: '0' })
  await qbPost('/journalentry?operation=update', { Line: [] })
  await qbGet('/journalentry/123')
  await qbPost('/deposit', { Line: [] })
  assert.deepEqual(writes[0].body, update)
  assert.ok(writes.every(w => !w.body?.DocNumber))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM qb_journal_sequences').get().n, 0)
})

test('conserve un compteur distinct par entreprise et reprend sa séquence au retour', async () => {
  await qbPost('/journalentry', { Line: [] })
  db.prepare(`UPDATE connector_oauth SET metadata = '{"realm_id":"company-b"}' WHERE id = 'qb-number-test'`).run()
  await qbPost('/journalentry', { Line: [] })
  db.prepare(`UPDATE connector_oauth SET metadata = '{"realm_id":"company-a"}' WHERE id = 'qb-number-test'`).run()
  await qbPost('/journalentry', { Line: [] })
  assert.deepEqual(writes.map(w => w.body.DocNumber), ['ERP-JE-000001', 'ERP-JE-000001', 'ERP-JE-000002'])
})

test('ne réutilise pas un numéro après une réponse réseau perdue', async () => {
  const successFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Réponse perdue') }
  await assert.rejects(qbPost('/journalentry', { Line: [] }), /Réponse perdue/)
  globalThis.fetch = successFetch
  const result = await qbPost('/journalentry', { Line: [] })
  assert.equal(result.JournalEntry.DocNumber, 'ERP-JE-000002')
})
