import '../test-helpers/testEnv.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { buildPaymentDeposit, postRevenueRecognitionJE } from './quickbooks.js'

const invoice = { subtotal: 2320000, total: 2359440, total_excluding_tax: 2088000, total_discount_amounts: [{ amount: 232000 }] }
const writes = []
const originalFetch = globalThis.fetch

before(() => {
  initTestDb()
  db.prepare(`INSERT INTO connector_oauth (id, connector, account_key, access_token, metadata)
    VALUES ('qb-test', 'quickbooks', 'default', 'fake-test-token', '{"realm_id":"test"}')`).run()
  globalThis.fetch = async (url, options) => {
    if (options.method === 'GET' && String(url).includes('/query?')) {
      const Account = [
        ...['Compte chèques Banque Nationale', 'Venn USD', 'Stripe Charge Back'].map((Name, i) => ({ Id: `bank-${i}`, Name })),
        ...['12000', '12100', '12900', '23900', '40000', '41000'].map(AcctNum => ({ Id: AcctNum, Name: AcctNum, AcctNum })),
      ]
      return new Response(JSON.stringify({ QueryResponse: { Account } }))
    }
    assert.equal(options.method, 'POST')
    assert.ok(String(url).includes('/journalentry'))
    writes.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ JournalEntry: { Id: 'test-je' } }))
  }
})
after(() => { globalThis.fetch = originalFetch })

function seed(extra = {}) {
  const id = randomUUID()
  db.prepare(`INSERT INTO factures (id, document_date, kind, status, currency, amount_before_tax_cad, total_amount,
    deferred_revenue_at, deferred_revenue_amount_native, deferred_revenue_currency)
    VALUES (?, '2026-09-21', 'order', 'Payé', 'CAD', 20880, 23594.4, ?, ?, ?)`).run(
    id, extra.deferred_revenue_at || null, extra.deferred_revenue_amount_native || null, extra.deferred_revenue_currency || null,
  )
  return id
}

test('payload dépôt : HT 20 880 + TVH 13 % = encaissement de 23 594,40', async () => {
  const result = await buildPaymentDeposit({ factureId: seed(), amount: 23594.4, invoice, taxCodeId: 'hst' })
  assert.equal(result.deposit.Line[0].Amount, 20880)
  assert.equal(result.deposit.Line[0].DepositLineDetail.TaxCodeRef.value, 'hst')
  assert.equal(Math.round(result.deposit.Line[0].Amount * 1.13 * 100) / 100, 23594.4)
  assert.equal(writes.length, 0)
})

test('payload JE : ancien différé brut plafonné au revenu net, sans nouvelle taxe', async () => {
  const id = seed({ deferred_revenue_at: '2026-09-04', deferred_revenue_amount_native: 23200, deferred_revenue_currency: 'CAD' })
  await postRevenueRecognitionJE(id, { bypassShipmentCheck: true })
  assert.deepEqual(writes[0].Line.map(l => l.Amount), [20880, 20880])
  assert.equal(writes[0].Line[0].JournalEntryLineDetail.AccountRef.value, '23900')
  assert.equal(writes[0].Line[1].JournalEntryLineDetail.AccountRef.value, '40000')
  assert.equal(writes[0].Line[0].JournalEntryLineDetail.TaxCodeRef, undefined)
  await assert.rejects(() => postRevenueRecognitionJE(id, { bypassShipmentCheck: true }), /déjà constatée/)
  assert.equal(writes.length, 1)
})

test('Stripe indisponible : aucune publication sur un ancien montant et claim JE libéré', async () => {
  const id = seed()
  db.prepare("UPDATE factures SET invoice_id = 'in_unavailable' WHERE id = ?").run(id)
  const count = writes.length
  await assert.rejects(() => buildPaymentDeposit({ factureId: id, amount: 23594.4, taxCodeId: 'hst' }), /montant net de rabais/)
  await assert.rejects(() => postRevenueRecognitionJE(id, { bypassShipmentCheck: true }), /Stripe non configuré/)
  assert.equal(db.prepare('SELECT revenue_recognized_at FROM factures WHERE id = ?').get(id).revenue_recognized_at, null)
  assert.equal(writes.length, count)
})
