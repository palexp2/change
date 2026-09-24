// Contrôles comptables : la mémoire des constatations et les contrôles qui ne
// lisent que la base.
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const tmpDbPath = join(tmpdir(), `erp-test-audit-${process.pid}.db`)
process.env.DATABASE_PATH = tmpDbPath

const bootDb = new Database(tmpDbPath)
bootDb.exec(`
  CREATE TABLE audit_findings (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'banque',
    severity TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    fingerprint TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT,
    data TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    dismissed_by TEXT,
    dismissed_reason TEXT,
    dismissed_at TEXT,
    resolved_at TEXT,
    first_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX idx_audit_findings_fp ON audit_findings(fingerprint);
  CREATE TABLE connector_oauth (connector TEXT, account_email TEXT, metadata TEXT, refresh_token TEXT, updated_at TEXT);
  CREATE TABLE bank_accounts (id TEXT PRIMARY KEY, name TEXT, qb_account_id TEXT, currency TEXT, deleted_at TEXT);
  CREATE TABLE bank_transactions (
    id TEXT PRIMARY KEY, account_id TEXT, txn_date TEXT, description TEXT, details TEXT,
    amount REAL, status TEXT DEFAULT 'rapproche', pending INTEGER DEFAULT 0,
    qb_txn_id TEXT, qb_txn_type TEXT, qb_match_method TEXT, deleted_at TEXT
  );
`)
bootDb.close()

const store = await import('./store.js')
const { lienPartage, doublonReleve, lienIntrouvable, typeInconnu } = await import('./checks/bank.js')
const db = (await import('../../db/database.js')).default
const { closedYearsFiltered } = await import('./index.js')

db.prepare(`INSERT INTO bank_accounts (id,name,qb_account_id,currency) VALUES ('cad','BNC CAD','61','CAD')`).run()
db.prepare(`INSERT INTO bank_accounts (id,name,qb_account_id,currency) VALUES ('mc','MasterCard BNC','66','CAD')`).run()

let seq = 0
function txn(f) {
  const id = f.id || `t${++seq}`
  db.prepare(`
    INSERT INTO bank_transactions (id,account_id,txn_date,description,details,amount,status,qb_txn_id,qb_txn_type,qb_match_method)
    VALUES (@id,@account_id,@txn_date,@description,@details,@amount,@status,@qb_txn_id,@qb_txn_type,@qb_match_method)
  `).run({
    description: null, details: null, status: 'rapproche', qb_txn_id: null,
    qb_txn_type: null, qb_match_method: 'exact', ...f, id,
  })
  return id
}
const reset = () => {
  db.prepare('DELETE FROM bank_transactions').run()
  db.prepare('DELETE FROM audit_findings').run()
}

test('mémoire : une constatation écartée ne revient jamais', () => {
  reset()
  const f = { severity: 'high', fingerprint: 'x|1', title: 'A' }
  store.syncCheck('c1', [f])
  const [row] = store.listFindings({ checkId: 'c1' })
  store.dismissFinding(row.id, null, 'connu')
  store.syncCheck('c1', [f])
  assert.equal(store.listFindings({ checkId: 'c1', status: 'open' }).length, 0)
  assert.equal(store.listFindings({ checkId: 'c1', status: 'dismissed' }).length, 1)
})

test('mémoire : une constatation qui disparaît est réglée, pas effacée', () => {
  reset()
  store.syncCheck('c1', [{ severity: 'low', fingerprint: 'x|2', title: 'B' }])
  const out = store.syncCheck('c1', [])
  assert.equal(out.resolved, 1)
  assert.equal(store.listFindings({ checkId: 'c1', status: 'resolved' }).length, 1)
})

test('deux jambes d’un paiement de carte : rien à signaler', () => {
  reset()
  txn({ account_id: 'cad', txn_date: '2026-09-05', amount: -3704.36, qb_txn_id: '14721', qb_txn_type: 'creditcardcredit' })
  txn({ account_id: 'mc', txn_date: '2026-09-08', amount: -3704.36, qb_txn_id: '14721', qb_txn_type: 'creditcardcredit' })
  assert.equal(lienPartage.run().length, 0)
})

test('même écriture deux fois sur le MÊME compte : signalé', () => {
  reset()
  txn({ account_id: 'cad', txn_date: '2026-09-05', amount: -100, qb_txn_id: '999', qb_txn_type: 'expense' })
  txn({ account_id: 'cad', txn_date: '2026-09-06', amount: -100, qb_txn_id: '999', qb_txn_type: 'expense' })
  const out = lienPartage.run()
  assert.equal(out.length, 1)
  assert.equal(out[0].severity, 'high')
  assert.match(out[0].fingerprint, /999$/)
})

test('deux lignes identiques importées : signalées une fois', () => {
  reset()
  const d = new Date().toISOString().slice(0, 10)
  txn({ account_id: 'cad', txn_date: d, amount: -8, description: 'FRAIS' })
  txn({ account_id: 'cad', txn_date: d, amount: -8, description: 'FRAIS' })
  txn({ account_id: 'cad', txn_date: d, amount: -9, description: 'FRAIS' })
  const out = doublonReleve.run()
  assert.equal(out.length, 1)
  assert.equal(out[0].data.ids.length, 2)
})

test('lien vers une écriture absente du grand livre : signalé ; présente : silence', () => {
  reset()
  txn({ id: 'ok', account_id: 'cad', txn_date: '2026-09-05', amount: -8, qb_txn_id: '17621', qb_txn_type: 'expense' })
  txn({ id: 'ko', account_id: 'cad', txn_date: '2026-09-06', amount: -12, qb_txn_id: '40404', qb_txn_type: 'expense' })
  const entries = [{ qbId: '17621', date: '2026-09-05', amount: -8, accountId: 'cad' }]
  const index = { byAccount: new Map([['cad', entries]]), all: entries }
  const accounts = db.prepare('SELECT * FROM bank_accounts').all()
  const out = lienIntrouvable.run({ accounts, index, window: { from: '2026-06-01', to: '2026-12-31' } })
  assert.equal(out.length, 1)
  assert.equal(out[0].entity_id, 'ko')
})

test('type d’écriture inconnu : un signalement par libellé, avec le compte', () => {
  const all = [
    { type: 'Dépense', date: '2026-09-01', amount: -5 },
    { type: 'Frais bancaires', date: '2026-09-02', amount: -8 },
    { type: 'Frais bancaires', date: '2026-09-03', amount: -8 },
  ]
  const out = typeInconnu.run({ index: { all } })
  assert.equal(out.length, 1)
  assert.equal(out[0].data.count, 2)
  assert.match(out[0].title, /Frais bancaires/)
})


test('une constatation sur un exercice clos n’est pas retenue', () => {
  const findings = [
    { entity_type: 'bank_transaction', entity_id: 'x', data: { date: '2025-11-22' } },
    { entity_type: 'bank_transaction', entity_id: 'y', data: { date: '2026-09-04' } },
    { entity_type: 'autre', entity_id: 'z' },
  ]
  const out = closedYearsFiltered(findings, {})
  assert.deepEqual(out.map((f) => f.entity_id), ['y', 'z'])
  // La barre peut être retirée par la configuration de l'automation.
  assert.equal(closedYearsFiltered(findings, { closed_before: '' }).length, 3)
})
