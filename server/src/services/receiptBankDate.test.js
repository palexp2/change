// La date d'une facture appariée est celle de son débit — la date imprimée est
// conservée à part.
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-receipt-bank-date-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE sale_receipts (id TEXT PRIMARY KEY, company TEXT, receipt_date TEXT, document_date TEXT, deleted_at TEXT, updated_at TEXT);
  CREATE TABLE bank_transactions (id TEXT PRIMARY KEY, account_id TEXT, txn_date TEXT, matched_type TEXT, matched_id TEXT, deleted_at TEXT);
`)
bootDb.close()

const { alignReceiptDate, alignReceiptDatesForAccount, bankDateForReceipt } = await import('./receiptBankDate.js')
const db = (await import('../db/database.js')).default

function seed(receiptDate, txnDate) {
  db.prepare('DELETE FROM sale_receipts').run()
  db.prepare('DELETE FROM bank_transactions').run()
  db.prepare(`INSERT INTO sale_receipts (id, company, receipt_date) VALUES ('r1','Bell Mobilité',?)`).run(receiptDate)
  if (txnDate) {
    db.prepare(`INSERT INTO bank_transactions (id, account_id, txn_date, matched_type, matched_id) VALUES ('t1','acc',?,'receipt','r1')`).run(txnDate)
  }
}
const receipt = () => db.prepare('SELECT * FROM sale_receipts WHERE id=?').get('r1')

test('cas Bell Mobilité : facture du 13, débit le 17 → la date devient le 17', () => {
  seed('2026-09-13', '2026-09-17')
  assert.equal(alignReceiptDate('r1'), true)
  assert.equal(receipt().receipt_date, '2026-09-17')
  assert.equal(receipt().document_date, '2026-09-13')
})

test('sans ligne au relevé, la date du document reste la seule', () => {
  seed('2026-09-13', null)
  assert.equal(alignReceiptDate('r1'), false)
  assert.equal(receipt().receipt_date, '2026-09-13')
  assert.equal(receipt().document_date, null)
  assert.equal(bankDateForReceipt('r1'), null)
})

test('deuxième passage : la date imprimée n’est pas écrasée par la date déjà recalée', () => {
  seed('2026-09-13', '2026-09-17')
  alignReceiptDate('r1')
  db.prepare("UPDATE bank_transactions SET txn_date='2026-09-18' WHERE id='t1'").run()
  assert.equal(alignReceiptDate('r1'), true)
  assert.equal(receipt().receipt_date, '2026-09-18')
  assert.equal(receipt().document_date, '2026-09-13')
})

test('par compte : ne touche que les factures dont la date diffère', () => {
  seed('2026-09-17', '2026-09-17')
  assert.equal(alignReceiptDatesForAccount('acc'), 0)
  seed('2026-09-13', '2026-09-17')
  assert.equal(alignReceiptDatesForAccount('acc'), 1)
})
