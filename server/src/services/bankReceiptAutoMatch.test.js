// Sens inverse du matching bancaire : une facture qui vient d'être extraite
// cherche la sortie d'argent qui l'attendait au relevé (autoMatchReceipt), et
// la fiche du document sait retrouver son débit (bankTxnForDocument).
//
// Tests au niveau service sur la DB jetable du harnais. `transfer_txn_id` vient
// de la migration 031, jouée seule (runMigrations rejouerait des reprises de
// données qui supposent une base réelle).
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { up as addTransferColumns } from '../db/migrations/031-bank-transfer-link.js'
import { autoMatchReceipt, autoMatchAccount, bankTxnForDocument, findCandidates } from './bankReconciliation.js'

const CAD = 'acct-bnc-cad'
const USD = 'acct-venn-usd'

let seq = 0

function seedAccounts() {
  const ins = db.prepare('INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency) VALUES (?,?,?,?)')
  ins.run(CAD, 'BNC CAD', 'bank', 'CAD')
  ins.run(USD, 'Venn USD', 'bank', 'USD')
}

function txn({ account_id = CAD, txn_date = '2026-09-03', amount = -250.75, label = 'ACHAT DIGIKEY CORP', pending = 0 } = {}) {
  const id = `txn-${++seq}`
  db.prepare(`
    INSERT INTO bank_transactions (id, account_id, txn_date, description, details, amount, dedup_key, status, pending)
    VALUES (?,?,?,?,?,?,?, 'a_traiter', ?)
  `).run(id, account_id, txn_date, label, label, amount, `${id}-key`, pending)
  return id
}

function receipt({ company = 'Digikey', receipt_date = '2026-09-02', total = 250.75, currency = 'CAD', status = 'done' } = {}) {
  const id = `rec-${++seq}`
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, company, receipt_date, total, currency, status)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, `${id}.pdf`, company, receipt_date, total, currency, status)
  return id
}

const get = (id) => db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)

describe('autoMatchReceipt', () => {
  before(() => {
    initTestDb()
    addTransferColumns(db)
    seedAccounts()
  })

  beforeEach(() => {
    db.exec('DELETE FROM bank_transactions')
    db.exec('DELETE FROM sale_receipts')
  })

  it('rattache le débit dont le libellé reconnaît le fournisseur', () => {
    const t = txn()
    const r = receipt()
    const res = autoMatchReceipt(r)
    assert.equal(res.matched, 1)
    const row = get(t)
    assert.equal(row.matched_type, 'receipt')
    assert.equal(row.matched_id, r)
    assert.equal(row.match_method, 'auto')
    assert.equal(row.status, 'facture_recue')
  })

  it('refuse un montant identique dont le libellé ne dit rien du fournisseur', () => {
    txn({ label: 'PAIEMENT PREAUTORISE 8841' })
    const res = autoMatchReceipt(receipt())
    assert.equal(res.matched, 0)
  })

  it('ne devine pas entre deux débits du même montant chez le même fournisseur', () => {
    txn({ txn_date: '2026-09-03' })
    txn({ txn_date: '2026-09-05' })
    const res = autoMatchReceipt(receipt())
    assert.equal(res.matched, 0)
    assert.equal(res.ambiguous, true)
  })

  // Le même chiffre dans une autre devise n'est pas le même argent : le débit
  // d'une facture USD porte le montant converti. La ligne est regardée (le
  // pré-filtre est large), elle n'est jamais attachée.
  it('ne prend pas un débit CAD du même chiffre pour une facture USD', () => {
    txn({ account_id: CAD })
    const res = autoMatchReceipt(receipt({ currency: 'USD' }))
    assert.equal(res.matched, 0)
  })

  it('ignore une transaction encore en attente à la banque', () => {
    txn({ pending: 1 })
    assert.equal(autoMatchReceipt(receipt()).matched, 0)
  })

  it('laisse tranquille une transaction déjà appariée à la main', () => {
    const t = txn()
    db.prepare("UPDATE bank_transactions SET matched_type='achat', matched_id='ach-1', match_method='manuel' WHERE id=?").run(t)
    assert.equal(autoMatchReceipt(receipt()).matched, 0)
    assert.equal(get(t).matched_id, 'ach-1')
  })

  it('ne relie pas deux fois une facture déjà rattachée ailleurs', () => {
    const r = receipt()
    const t1 = txn()
    autoMatchReceipt(r)
    txn({ txn_date: '2026-09-04' })
    assert.equal(autoMatchReceipt(r), null)
    assert.equal(get(t1).matched_id, r)
  })

  it('ne fait rien tant que l’extraction n’est pas terminée', () => {
    txn()
    assert.equal(autoMatchReceipt(receipt({ status: 'processing' })), null)
  })

  // Une facture nette 30 est débitée des semaines plus tard : la fenêtre va
  // jusqu'à 45 jours APRÈS la pièce, mais pas au-delà, et reste étroite avant.
  it('rattache un débit trente jours après la facture', () => {
    const t = txn({ txn_date: '2026-10-02' })
    assert.equal(autoMatchReceipt(receipt()).matched, 1)
    assert.equal(get(t).matched_type, 'receipt')
  })

  it('ne sort pas de la fenêtre', () => {
    txn({ txn_date: '2026-12-20' })
    assert.equal(autoMatchReceipt(receipt()).scanned, 0)
  })

  it('ignore une facture à zéro dollar', () => {
    txn({ amount: 0 })
    assert.equal(autoMatchReceipt(receipt({ total: 0 })), null)
  })
})

describe('bankTxnForDocument', () => {
  before(() => { initTestDb(); addTransferColumns(db); seedAccounts() })
  beforeEach(() => { db.exec('DELETE FROM bank_transactions'); db.exec('DELETE FROM sale_receipts') })

  it('rend le débit avec son compte, ou rien', () => {
    assert.equal(bankTxnForDocument('receipt', null), null)
    const r = receipt()
    assert.equal(bankTxnForDocument('receipt', r), null)
    txn()
    autoMatchReceipt(r)
    const found = bankTxnForDocument('receipt', r)
    assert.equal(found.account_name, 'BNC CAD')
    assert.equal(found.amount, -250.75)
    assert.equal(found.match_method, 'auto')
  })
})

// Le sens relevé → pièce, avec les deux garde-fous qui n'ont pas bougé : le
// fournisseur doit être reconnu au relevé, et une ligne déjà rapprochée ne perd
// pas son vert en gagnant sa pièce.
describe('autoMatchAccount', () => {
  before(() => { initTestDb(); addTransferColumns(db); seedAccounts() })
  beforeEach(() => { db.exec('DELETE FROM bank_transactions'); db.exec('DELETE FROM sale_receipts') })

  it('n’attache rien sur le seul montant', () => {
    const t = txn({ label: 'PAIEMENT PREAUTORISE 8841' })
    receipt()
    assert.equal(autoMatchAccount(CAD).matched, 0)
    assert.equal(get(t).matched_id, null)
  })

  it('attache la pièce d’une ligne déjà rapprochée sans la déverdir', () => {
    const t = txn()
    db.prepare("UPDATE bank_transactions SET status='rapproche', reconciled_at='2026-09-04T00:00:00Z' WHERE id=?").run(t)
    const r = receipt()
    assert.equal(autoMatchAccount(CAD).matched, 1)
    const row = get(t)
    assert.equal(row.matched_id, r)
    assert.equal(row.status, 'rapproche')
  })
})

// Une entrée d'argent se paie par une pièce négative (remboursement, note de
// crédit), jamais par une facture ; une sortie, jamais par une pièce négative.
describe('sens de l’argent', () => {
  before(() => { initTestDb(); addTransferColumns(db); seedAccounts() })
  beforeEach(() => { db.exec('DELETE FROM bank_transactions'); db.exec('DELETE FROM sale_receipts') })

  const refund = () => receipt({ company: 'Agence du revenu du Canada', receipt_date: '2026-09-16', total: -121215.70 })
  const entry = () => txn({ txn_date: '2026-09-22', amount: 121215.70, label: 'REMB. IMPOT CANADA' })

  it('propose le remboursement à l’entrée, sûr', () => {
    const r = refund()
    const c = findCandidates(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(entry()))
    assert.equal(c[0]?.id, r)
    assert.equal(c[0]?.verdict, 'sure')
    assert.ok(c[0].confidence >= 0.8)
  })

  it('ne propose jamais une pièce négative à une sortie', () => {
    refund()
    const t = txn({ txn_date: '2026-09-22', amount: -121215.70, label: 'REMB. IMPOT CANADA' })
    assert.equal(findCandidates(get(t)).length, 0)
  })

  it('ne propose jamais une facture à une entrée', () => {
    receipt()
    const t = txn({ amount: 250.75 })
    assert.equal(findCandidates(get(t)).filter(c => c.type === 'receipt').length, 0)
  })

  it('autoMatchReceipt : la pièce négative rejoint son entrée', () => {
    const t = entry()
    const r = refund()
    assert.equal(autoMatchReceipt(r).matched, 1)
    assert.equal(get(t).matched_id, r)
  })

  it('autoMatchReceipt : une facture ne touche pas une entrée du même montant', () => {
    txn({ amount: 250.75 })
    assert.equal(autoMatchReceipt(receipt()).scanned, 0)
  })
})
