import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { findPaieBankDebit, linkPaiesToBankDebits } from './paieSalaryExpense.js'
import { getPaieRepartitionConfig } from './paieRepartition.js'
import { recordBalance } from './treasury.js'

// Le compte réellement configuré pour la recherche (« BNC CAD ») : les
// transactions de test y sont ajoutées puis retirées, aucune vraie ligne n'est
// touchée (ids et clés de dédup préfixés « test- »).
const cfg = getPaieRepartitionConfig()
const accountId = db.prepare('SELECT id FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(cfg.bank_account_name)?.id

function addTxn(id, txnDate, amount, description, pending = 0) {
  db.prepare(`INSERT OR REPLACE INTO bank_transactions
    (id, account_id, txn_date, description, amount, dedup_key, pending, created_at)
    VALUES (?,?,?,?,?,?,?, '2026-01-01T00:00:00.000Z')`)
    .run(id, accountId, txnDate, description, amount, `test-dedup-${id}`, pending)
}
const dropTxn = id => db.prepare('DELETE FROM bank_transactions WHERE id=?').run(id)

test('findPaieBankDebit : le débit Nethris de la quinzaine est trouvé et proposé', { skip: !accountId }, () => {
  const paieId = 'test-paie-bank-debit'
  db.prepare(`INSERT OR REPLACE INTO paies (id, period_start, period_end) VALUES (?, '2019-08-18', '2019-08-31')`).run(paieId)
  addTxn('test-bdl-paie-1', '2019-09-02', -20932.32, 'COMPTE DIVERS DT NETHRIS PAIE')
  addTxn('test-bdl-paie-2', '2019-09-02', -49.84, 'COMPTE DIVERS DT NETHRIS SERV')
  try {
    const r = findPaieBankDebit(paieId)
    assert.equal(r.match?.id, 'test-bdl-paie-1')
    assert.equal(r.match.amount, 20932.32)
    assert.equal(r.match.txn_date, '2019-09-02')
    assert.equal(r.linked_txn_id, null)

    // Rattachement automatique : la paie porte le débit, aucune écriture QB.
    const linked = linkPaiesToBankDebits()
    const mine = linked.find(l => l.paie_id === paieId)
    // La paie de test est trop ancienne pour la fenêtre de 90 jours du passage
    // automatique : c'est voulu (on ne remonte pas indéfiniment).
    assert.equal(mine, undefined)
    assert.equal(db.prepare('SELECT bank_txn_id FROM paies WHERE id=?').get(paieId).bank_txn_id, null)
  } finally {
    dropTxn('test-bdl-paie-1'); dropTxn('test-bdl-paie-2')
    db.prepare('DELETE FROM paies WHERE id=?').run(paieId)
  }
})

test('findPaieBankDebit : un débit déjà rattaché à une autre paie n\'est jamais volé', { skip: !accountId }, () => {
  const mine = 'test-paie-bank-debit-mine'
  const other = 'test-paie-bank-debit-other'
  db.prepare(`INSERT OR REPLACE INTO paies (id, period_start, period_end) VALUES (?, '2019-08-18', '2019-08-31')`).run(mine)
  db.prepare(`INSERT OR REPLACE INTO paies (id, period_start, period_end, bank_txn_id) VALUES (?, '2019-08-04', '2019-08-17', 'test-bdl-paie-3')`).run(other)
  addTxn('test-bdl-paie-3', '2019-09-02', -20932.32, 'COMPTE DIVERS DT NETHRIS PAIE')
  try {
    assert.equal(findPaieBankDebit(mine).match, null, 'le débit appartient déjà à l\'autre paie')
    assert.equal(findPaieBankDebit(other).match?.id, 'test-bdl-paie-3', 'la paie propriétaire le garde')
  } finally {
    dropTxn('test-bdl-paie-3')
    db.prepare('DELETE FROM paies WHERE id IN (?,?)').run(mine, other)
  }
})

test('findPaieBankDebit : sans fin de période, aucune recherche (et aucune erreur)', () => {
  const paieId = 'test-paie-bank-debit-noend'
  db.prepare(`INSERT OR REPLACE INTO paies (id) VALUES (?)`).run(paieId)
  try {
    const r = findPaieBankDebit(paieId)
    assert.equal(r.match, null)
    assert.deepEqual(r.candidates, [])
  } finally {
    db.prepare('DELETE FROM paies WHERE id=?').run(paieId)
  }
})

test('recordBalance : un solde Plaid identique et récent n\'est pas ré-enregistré', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM treasury_balances').get().n
  const created = []
  try {
    const first = recordBalance({ balance: 12345.67, source: 'plaid' })
    created.push(first.entry.id)
    assert.equal(first.skipped, false)
    assert.equal(first.entry.source, 'plaid')

    // Même montant, quelques millisecondes plus tard : rien de neuf à noter.
    const again = recordBalance({ balance: 12345.67, source: 'plaid', minAgeMinutes: 360 })
    assert.equal(again.skipped, true)
    assert.equal(again.entry.id, first.entry.id)

    // Un montant différent est toujours enregistré, même dans la fenêtre.
    const moved = recordBalance({ balance: 12000, source: 'plaid', minAgeMinutes: 360 })
    created.push(moved.entry.id)
    assert.equal(moved.skipped, false)

    assert.equal(db.prepare('SELECT COUNT(*) n FROM treasury_balances').get().n, before + 2)
  } finally {
    for (const id of created) db.prepare('DELETE FROM treasury_balances WHERE id=?').run(id)
  }
})

test('recordBalance : un montant illisible est refusé, rien n\'est écrit', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM treasury_balances').get().n
  assert.throws(() => recordBalance({ balance: 'douze mille' }), /nombre/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treasury_balances').get().n, before)
})
