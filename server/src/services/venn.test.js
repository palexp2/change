import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { extractList, nextCursorOf, normalizeAccount, normalizeTransaction, signedAmount, vennErrorMessage } from './venn.js'
import { upsertVennTransaction, vennDedupKey, defaultWindow } from './vennSync.js'

test('extractList : accepte les enveloppes courantes', () => {
  assert.deepEqual(extractList([1, 2]), [1, 2])
  assert.deepEqual(extractList({ data: [1] }), [1])
  assert.deepEqual(extractList({ items: [2] }), [2])
  assert.deepEqual(extractList({ data: { items: [3] } }), [3])
  assert.deepEqual(extractList({ foo: 1 }), [])
})

test('nextCursorOf : null quand il n’y a plus de page', () => {
  assert.equal(nextCursorOf({ nextCursor: 'abc' }), 'abc')
  assert.equal(nextCursorOf({ pagination: { next_cursor: 'x' } }), 'x')
  assert.equal(nextCursorOf({ nextCursor: null }), null)
  assert.equal(nextCursorOf({}), null)
})

test('normalizeAccount : soldes disponible ET courant, devise en majuscules', () => {
  const a = normalizeAccount({ id: 'acc_1', nickname: 'Operating CAD', currencyCode: 'cad', balances: { available: 12.5, current: 20 } })
  assert.deepEqual(a, { venn_account_id: 'acc_1', name: 'Operating CAD', currency: 'CAD', balance_available: 12.5, balance_current: 20 })
  assert.equal(normalizeAccount({ name: 'sans id' }), null)
})

test('signedAmount : dépôt positif, retrait négatif (convention du relevé)', () => {
  assert.equal(signedAmount({ amount: 100, direction: 'debit' }), -100)
  assert.equal(signedAmount({ amount: -100, direction: 'DEBIT' }), -100)
  assert.equal(signedAmount({ amount: 100, type: 'credit' }), 100)
  // Sans direction déclarée, le signe donné fait foi.
  assert.equal(signedAmount({ amount: -42.5 }), -42.5)
  assert.equal(signedAmount({}), null)
})

test('normalizeTransaction : libellé brut dans details, commerçant dans description', () => {
  const t = normalizeTransaction({
    id: 'txn_9', postedAt: '2026-09-18T14:02:00Z', amount: 37.49, direction: 'debit',
    description: 'POS PURCHASE ACME 4412', merchantName: 'Acme', currency: 'USD', status: 'posted',
  })
  assert.equal(t.venn_transaction_id, 'txn_9')
  assert.equal(t.txn_date, '2026-09-18')
  assert.equal(t.amount, -37.49)
  assert.equal(t.description, 'Acme')
  assert.equal(t.details, 'POS PURCHASE ACME 4412')
  assert.equal(t.currency, 'USD')   // jamais convertie
  assert.equal(t.pending, false)
})

test('normalizeTransaction : une ligne sans date ni montant exploitable est écartée', () => {
  assert.equal(normalizeTransaction({ id: 'x', amount: 5 }), null)
  assert.equal(normalizeTransaction({ date: '2026-09-01', amount: 5 }), null)
  assert.equal(normalizeTransaction({ id: 'x', date: '2026-09-01' }), null)
})

test('normalizeTransaction : en attente reconnu', () => {
  assert.equal(normalizeTransaction({ id: 'x', date: '2026-09-01', amount: 1, status: 'PENDING' }).pending, true)
  assert.equal(normalizeTransaction({ id: 'y', date: '2026-09-01', amount: 1, pending: true }).pending, true)
})

test('vennErrorMessage : une clé morte se nomme, elle ne se tait pas', () => {
  assert.match(vennErrorMessage(401), /clé/)
  assert.match(vennErrorMessage(429), /429/)
  assert.match(vennErrorMessage(500, 'boom'), /500.*boom/)
})

test('defaultWindow : fenêtre glissante autour d’aujourd’hui', () => {
  const w = defaultWindow(30, new Date('2026-09-19T12:00:00Z'))
  assert.equal(w.from, '2026-08-20')
  assert.equal(w.to, '2026-09-20')
})

// Le cœur de la promesse « relancer la sync ne crée pas de doublon » : la clé
// externe est l'identifiant Venn, et une ligne déjà posée n'est plus touchée.
const ACC = 'test-venn-sync-account'
const cleanup = () => {
  db.prepare("DELETE FROM bank_transactions WHERE account_id=?").run(ACC)
  db.prepare('DELETE FROM bank_accounts WHERE id=?').run(ACC)
}

test('upsertVennTransaction : deux passages, une seule ligne', (t) => {
  cleanup()
  t.after(cleanup)
  db.prepare(`INSERT INTO bank_accounts (id, name, kind, currency, institution, venn_account_id)
    VALUES (?, 'ZZ Test Venn', 'bank', 'USD', 'Venn', 'venn-test-acct')`).run(ACC)
  const txn = { venn_transaction_id: 'tx-1', txn_date: '2026-09-10', amount: -25, description: 'Acme', details: null, pending: false }

  assert.deepEqual(upsertVennTransaction(ACC, txn), { inserted: 1, updated: 0 })
  assert.deepEqual(upsertVennTransaction(ACC, txn), { inserted: 0, updated: 0 })
  const rows = db.prepare('SELECT dedup_key, amount FROM bank_transactions WHERE account_id=?').all(ACC)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].dedup_key, vennDedupKey('tx-1'))
})

test('upsertVennTransaction : une ligne en attente se corrige, une ligne posée ne bouge plus', (t) => {
  cleanup()
  t.after(cleanup)
  db.prepare(`INSERT INTO bank_accounts (id, name, kind, currency, institution, venn_account_id)
    VALUES (?, 'ZZ Test Venn', 'bank', 'USD', 'Venn', 'venn-test-acct')`).run(ACC)

  upsertVennTransaction(ACC, { venn_transaction_id: 'tx-2', txn_date: '2026-09-10', amount: -10, description: 'Acme', details: null, pending: true })
  // Elle se pose avec son montant définitif : on la met à jour.
  assert.deepEqual(
    upsertVennTransaction(ACC, { venn_transaction_id: 'tx-2', txn_date: '2026-09-11', amount: -12, description: 'Acme', details: null, pending: false }),
    { inserted: 0, updated: 1 })
  let row = db.prepare('SELECT amount, pending, txn_date FROM bank_transactions WHERE dedup_key=?').get(vennDedupKey('tx-2'))
  assert.equal(row.amount, -12)
  assert.equal(row.pending, 0)
  assert.equal(row.txn_date, '2026-09-11')

  // Maintenant qu'elle est posée, une relecture ne la réécrit plus — le travail
  // comptable fait dessus doit survivre.
  assert.deepEqual(
    upsertVennTransaction(ACC, { venn_transaction_id: 'tx-2', txn_date: '2026-09-11', amount: -999, description: 'X', details: null, pending: false }),
    { inserted: 0, updated: 0 })
  row = db.prepare('SELECT amount FROM bank_transactions WHERE dedup_key=?').get(vennDedupKey('tx-2'))
  assert.equal(row.amount, -12)
})
