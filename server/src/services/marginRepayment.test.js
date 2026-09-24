// Le remboursement de la marge de crédit : un seul débit au compte courant,
// deux comptes à l'écriture (capital + intérêts).
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { totalFromLabel, marginRepaymentSplit } from './marginRepayment.js'

const CHQ = 'acct-desj-cad'
const MARGE = 'acct-marge'

describe('totalFromLabel', () => {
  it('lit le total annoncé au libellé', () => {
    assert.equal(totalFromLabel('Remboursement automatique /de EOP:19 686,89$ no'), 19686.89)
    assert.equal(totalFromLabel('Remboursement automatique /de EOP:531,23$ no'), 531.23)
    assert.equal(totalFromLabel('Payment transfer /to LC 02'), null)
  })
})

describe('marginRepaymentSplit', () => {
  before(() => {
    initTestDb()
    const ins = db.prepare('INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, qb_account_id) VALUES (?,?,?,?,?)')
    ins.run(CHQ, 'Desjardins CAD', 'bank', 'CAD', '236')
    ins.run(MARGE, 'Marge Desjardins', 'bank', 'CAD', '238')
  })
  beforeEach(() => { db.exec('DELETE FROM bank_transactions') })

  const line = (account_id, amount, description, interest = null) => {
    const id = `t-${account_id}-${Math.abs(amount)}`
    db.prepare(`
      INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status, interest_cad)
      VALUES (?,?,?,?,?,?, 'a_traiter', ?)
    `).run(id, account_id, '2026-09-01', description, amount, `${id}-key`, interest)
    return db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
  }
  const account = (id) => db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(id)

  it('coupe le débit du compte courant en capital et intérêts', () => {
    line(MARGE, -19000, 'Remboursement automatique /de EOP:19 686,89$ no', 686.89)
    const chq = line(CHQ, -19686.89, 'Virement-remboursement /à 0101247-MC2')
    const split = marginRepaymentSplit(chq, account(CHQ))
    assert.equal(split.principal, 19000)
    assert.equal(split.interest, 686.89)
    assert.equal(split.lines[0].expense_account_id, '238')
    assert.equal(split.lines[0].amount, 19000)
    assert.equal(split.lines[1].amount, 686.89)
  })

  it('retrouve les intérêts dans le libellé quand la colonne ne les porte pas', () => {
    line(MARGE, -19000, 'Remboursement automatique /de EOP:19 686,89$ no')
    const chq = line(CHQ, -19686.89, 'Virement-remboursement')
    assert.equal(marginRepaymentSplit(chq, account(CHQ)).interest, 686.89)
  })

  it('ne coupe rien sur la ligne de la marge elle-même', () => {
    const m = line(MARGE, -19000, 'Remboursement automatique /de EOP:19 686,89$ no', 686.89)
    assert.equal(marginRepaymentSplit(m, account(MARGE)), null)
  })

  it('ne coupe rien quand aucun remboursement ne correspond', () => {
    line(MARGE, -19000, 'Remboursement automatique /de EOP:19 686,89$ no', 686.89)
    const other = line(CHQ, -500, 'ACHAT QUELCONQUE')
    assert.equal(marginRepaymentSplit(other, account(CHQ)), null)
  })
})
