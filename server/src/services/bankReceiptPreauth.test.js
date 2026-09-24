// Achat en devise sur une carte CAD : pré-autorisation « en attente » puis
// passage au compte avec les frais de change. La pièce va à la ligne postée,
// la ligne en attente la montre sans la prendre (cas Anthropic, 2026-09-18).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { up as addTransferColumns } from '../db/migrations/031-bank-transfer-link.js'
import { up as addBankState } from '../db/migrations/074-bank-state-and-invoice-drop.js'
import { findDocCandidates, confidenceFromScore } from './bankReceiptMatch.js'
import { autoMatchReceipt } from './bankReconciliation.js'

const ACCT = { id: 'acct-mc-cad', currency: 'CAD', account_number: '5258-8186-****' }

function txn(id, amount, state, label) {
  db.prepare(`
    INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status, pending, bank_state)
    VALUES (?,?,?,?,?,?, 'a_traiter', 0, ?)
  `).run(id, ACCT.id, '2026-09-18', label, amount, `${id}-key`, state)
  return db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
}

describe('pré-autorisation vs passage', () => {
  let posted, pending
  before(() => {
    initTestDb()
    addTransferColumns(db)
    addBankState(db)
    db.prepare('INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, account_number) VALUES (?,?,?,?,?)')
      .run(ACCT.id, 'MasterCard BNC', 'card', 'CAD', ACCT.account_number)
    db.prepare("INSERT OR REPLACE INTO fx_rates (pair, date, rate) VALUES ('USDCAD', '2026-09-18', 1.4002)").run()
    db.prepare(`INSERT INTO sale_receipts (id, filename, company, receipt_date, total, currency, status)
                VALUES ('rec-anth', 'a.pdf', 'Anthropic', '2026-09-18', 105, 'CAD', 'done')`).run()
    posted = txn('t-posted', -150.72, 'autorise', 'ANTHROPIC SAN FRANCISCO CA USA CA Montant initial en devise USD 105,00')
    pending = txn('t-pending', -147.04, 'en_attente', 'ANTHROPIC SAN FRANCISCO CA USA CA')
  })

  it('la ligne postée reçoit la pièce, sûre', () => {
    const { candidates, ambiguous } = findDocCandidates(posted, ACCT)
    assert.equal(candidates[0].id, 'rec-anth')
    assert.equal(candidates[0].verdict, 'sure')
    assert.equal(ambiguous, false)
    assert.ok(confidenceFromScore(candidates[0]) >= 0.8)
  })

  it('la ligne en attente la montre sans la prendre', () => {
    const { candidates } = findDocCandidates(pending, ACCT)
    assert.equal(candidates[0].id, 'rec-anth')
    assert.notEqual(candidates[0].verdict, 'sure')
    assert.ok(candidates[0].reasons.some(r => r.startsWith('pré-autorisation')))
  })

  it('sens inverse : la pièce trouve la seule ligne postée', () => {
    const res = autoMatchReceipt('rec-anth')
    assert.equal(res.matched, 1)
    assert.equal(res.txnId, 't-posted')
  })
})
