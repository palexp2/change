import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { pairDuplicates, mergeSheetDuplicates, countSheetDuplicates } from './plaidSync.js'

const ACC = 'test-plaid-merge-account'

function seed(rows) {
  db.prepare(`INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, plaid_account_id)
    VALUES (?, 'ZZ Test Plaid Merge', 'bank', 'CAD', 'test-plaid-acct')`).run(ACC)
  for (const r of rows) {
    db.prepare(`INSERT OR REPLACE INTO bank_transactions
      (id, account_id, txn_date, description, details, amount, dedup_key, status, qb_txn_id, qb_txn_type, comment, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.id, ACC, r.txn_date, r.description || null, r.details || null, r.amount, r.dedup_key,
      r.status || 'a_traiter', r.qb_txn_id || null, r.qb_txn_type || null, r.comment || null,
      r.created_at || '2026-01-01T00:00:00.000Z')
  }
}
const cleanup = () => {
  db.prepare('DELETE FROM bank_transactions WHERE account_id=?').run(ACC)
  db.prepare('DELETE FROM bank_accounts WHERE id=?').run(ACC)
}

test('pairDuplicates : appariement 1-1, deux mouvements identiques le même jour restent deux', () => {
  const plaid = [
    { id: 'p1', txn_date: '2026-08-04', amount: -100 },
    { id: 'p2', txn_date: '2026-08-04', amount: -100 },
  ]
  const sheet = [
    { id: 's1', txn_date: '2026-08-04', amount: -100 },
    { id: 's2', txn_date: '2026-08-04', amount: -100 },
    { id: 's3', txn_date: '2026-08-04', amount: -100 }, // sans jumelle : reste
  ]
  const pairs = pairDuplicates(plaid, sheet)
  assert.equal(pairs.length, 2)
  assert.deepEqual(pairs.map(p => p.plaid.id), ['p1', 'p2'], 'aucune ligne Plaid consommée deux fois')
  assert.deepEqual(pairs.map(p => p.sheet.id), ['s1', 's2'])
})

test('pairDuplicates : un montant ou une date qui diffère ne fait pas une paire', () => {
  const plaid = [{ id: 'p1', txn_date: '2026-08-04', amount: -100 }]
  assert.equal(pairDuplicates(plaid, [{ id: 's1', txn_date: '2026-08-05', amount: -100 }]).length, 0)
  assert.equal(pairDuplicates(plaid, [{ id: 's1', txn_date: '2026-08-04', amount: -100.01 }]).length, 0)
})

test('mergeSheetDuplicates : la ligne Plaid hérite du statut, du lien QB et du libellé', () => {
  seed([
    { id: 'test-pm-plaid', txn_date: '2026-07-21', amount: -21542.85, dedup_key: 'plaid:tx1',
      description: 'Nethris', status: 'a_traiter' },
    { id: 'test-pm-sheet', txn_date: '2026-07-21', amount: -21542.85, dedup_key: 'sha1-abc',
      description: 'COMPTE DIVERS', details: 'DT NETHRIS PAIE', status: 'rapproche',
      qb_txn_id: '17670', qb_txn_type: 'purchase', comment: 'vérifiée par Pap' },
  ])
  try {
    assert.equal(countSheetDuplicates(ACC), 1)

    // Simulation : rien n'est écrit.
    const dry = mergeSheetDuplicates(ACC)
    assert.equal(dry.merged, 0)
    assert.equal(dry.pairs.length, 1)
    assert.equal(dry.pairs[0].inherit.status, 'rapproche')
    assert.equal(dry.pairs[0].inherit.qb_txn_id, '17670')
    assert.equal(db.prepare('SELECT deleted_at FROM bank_transactions WHERE id=?').get('test-pm-sheet').deleted_at, null)

    const applied = mergeSheetDuplicates(ACC, { apply: true })
    assert.equal(applied.merged, 1)
    const plaid = db.prepare('SELECT * FROM bank_transactions WHERE id=?').get('test-pm-plaid')
    assert.equal(plaid.status, 'rapproche', 'le statut le plus avancé gagne')
    assert.equal(plaid.qb_txn_id, '17670')
    assert.equal(plaid.qb_txn_type, 'purchase')
    assert.equal(plaid.details, 'DT NETHRIS PAIE', 'le libellé du relevé est conservé')
    assert.equal(plaid.comment, 'vérifiée par Pap')
    assert.equal(plaid.deleted_at, null)
    const sheet = db.prepare('SELECT * FROM bank_transactions WHERE id=?').get('test-pm-sheet')
    assert.ok(sheet.deleted_at, 'la ligne du fichier est retirée')
    assert.match(sheet.comment, /fusionnée/)

    // Plus rien à proposer, et un second passage ne casse rien.
    assert.equal(countSheetDuplicates(ACC), 0)
    assert.equal(mergeSheetDuplicates(ACC, { apply: true }).merged, 0)
  } finally { cleanup() }
})

test('mergeSheetDuplicates : le statut plus avancé de la ligne Plaid n\'est jamais écrasé', () => {
  seed([
    { id: 'test-pm-plaid2', txn_date: '2026-08-04', amount: -500, dedup_key: 'plaid:tx2', status: 'rapproche', qb_txn_id: '999' },
    { id: 'test-pm-sheet2', txn_date: '2026-08-04', amount: -500, dedup_key: 'sha1-def', status: 'a_traiter' },
  ])
  try {
    mergeSheetDuplicates(ACC, { apply: true })
    const plaid = db.prepare('SELECT * FROM bank_transactions WHERE id=?').get('test-pm-plaid2')
    assert.equal(plaid.status, 'rapproche')
    assert.equal(plaid.qb_txn_id, '999')
  } finally { cleanup() }
})

test('mergeSheetDuplicates : compte sans Plaid = rien à fusionner', () => {
  const plainAcc = 'test-plaid-merge-plain'
  db.prepare(`INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency) VALUES (?, 'ZZ Test Sans Plaid', 'bank', 'CAD')`).run(plainAcc)
  try {
    const r = mergeSheetDuplicates(plainAcc)
    assert.equal(r.merged, 0)
    assert.equal(r.pairs.length, 0)
    assert.equal(countSheetDuplicates(plainAcc), 0)
  } finally {
    db.prepare('DELETE FROM bank_accounts WHERE id=?').run(plainAcc)
  }
})
