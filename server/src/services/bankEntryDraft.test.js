// Le dossier de préparation d'une écriture : chaque champ porte sa source, et
// un champ sans source reste vide. Tests sur la DB jetable du harnais.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { buildEntryDraft } from './bankEntryDraft.js'
import { invalidateBankLabelCache } from './scrapers/vendorFromBankLabel.js'

const BNC = 'acct-bnc-cad'
const MCR = 'acct-mastercard'

let seq = 0

function seedAccounts() {
  const ins = db.prepare('INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, qb_account_id) VALUES (?,?,?,?,?)')
  ins.run(BNC, 'BNC CAD', 'bank', 'CAD', '61,999')
  ins.run(MCR, 'MasterCard BNC', 'card', 'CAD', '66')
}

function txn(fields = {}) {
  const id = `txn-draft-${++seq}`
  const row = {
    account_id: BNC, txn_date: '2026-09-01', amount: -115,
    description: 'PAIEMENT', details: null, reference: null,
    bank_category: null, txn_type: null, check_number: null,
    orig_currency: null, orig_amount: null,
    matched_type: null, matched_id: null,
    ...fields,
  }
  db.prepare(`
    INSERT INTO bank_transactions
      (id, account_id, txn_date, description, details, reference, amount, dedup_key, status,
       bank_category, txn_type, check_number, orig_currency, orig_amount, matched_type, matched_id)
    VALUES (?,?,?,?,?,?,?,?,'a_traiter',?,?,?,?,?,?,?)
  `).run(id, row.account_id, row.txn_date, row.description, row.details, row.reference, row.amount, `${id}-key`,
    row.bank_category, row.txn_type, row.check_number, row.orig_currency, row.orig_amount,
    row.matched_type, row.matched_id)
  return db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
}

const account = (id) => db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(id)

function publishedPurchase({ vendor, account_id = '5010', tax_code_id = null, memo = null, type = 'purchase', date = '2026-08-01' }) {
  const id = `ach-draft-${++seq}`
  db.prepare(`
    INSERT INTO achats_fournisseurs (id, type, date_achat, vendor, description, qb_memo, payment_method,
      amount_cad, tax_cad, total_cad, currency, status, expense_account_id, tax_code_id, quickbooks_id)
    VALUES (?,?,?,?,?,?, 'Comptant', 100, 0, 100, 'CAD', 'Approuvé', ?, ?, 'qb-1')
  `).run(id, type, date, vendor, memo, memo, account_id, tax_code_id)
  return id
}

describe('buildEntryDraft', () => {
  before(() => { initTestDb(); seedAccounts() })
  beforeEach(() => {
    db.exec('DELETE FROM bank_transactions')
    db.exec('DELETE FROM achats_fournisseurs')
    db.exec('DELETE FROM vendor_profiles')
    db.exec('DELETE FROM sale_receipts')
    // Le résolveur garde les profils 30 s : sans ça, un test lit ceux du précédent.
    invalidateBankLabelCache()
  })

  it('un champ sans source reste vide', () => {
    const d = buildEntryDraft(txn({ description: 'LIBELLE INCONNU XYZ' }), account(BNC))
    assert.equal(d.fields.vendor.value, null)
    assert.equal(d.fields.vendor.source, null)
    assert.equal(d.fields.expense_account_id.value, null)
    assert.equal(d.fields.memo.value, null)
    assert.deepEqual(d.missing, ['vendor', 'expense_account_id'])
    assert.equal(d.ready, false)
  })

  it('ce que le relevé donne toujours porte la source « relevé »', () => {
    const d = buildEntryDraft(txn({ amount: -115.5 }), account(BNC))
    assert.deepEqual(d.fields.date, { value: '2026-09-01', source: 'relevé' })
    assert.deepEqual(d.fields.total, { value: 115.5, source: 'relevé' })
  })

  it('l\'habitude remplit le compte de dépense et se compte', () => {
    publishedPurchase({ vendor: 'Novo Express', account_id: '5010' })
    publishedPurchase({ vendor: 'Novo Express', account_id: '5010' })
    publishedPurchase({ vendor: 'Novo Express', account_id: '5020' })
    const d = buildEntryDraft(txn({ description: 'NOVO EXPRESS MONTREAL' }), account(BNC))
    assert.equal(d.fields.vendor.value, 'Novo Express')
    assert.equal(d.fields.expense_account_id.value, '5010')
    assert.equal(d.fields.expense_account_id.source, 'habitude : 2 fois sur 3')
    assert.equal(d.ready, true)
  })

  it('le profil du fournisseur prime sur l\'habitude', () => {
    db.prepare('INSERT INTO vendor_profiles (id, name, default_expense_account_id) VALUES (?,?,?)')
      .run('vp-1', 'Novo Express', '5099')
    publishedPurchase({ vendor: 'Novo Express', account_id: '5010' })
    const d = buildEntryDraft(txn({ description: 'NOVO EXPRESS MONTREAL' }), account(BNC))
    assert.equal(d.fields.expense_account_id.value, '5099')
    assert.equal(d.fields.expense_account_id.source, 'profil du fournisseur')
  })

  it('les taxes viennent du document apparié, pas d\'un taux nominal', () => {
    db.prepare(`
      INSERT INTO sale_receipts (id, filename, status, receipt_date, company, receipt_number,
        subtotal, tps, tvq, other_taxes, total, currency)
      VALUES ('rec-1','f.pdf','done','2026-09-01','Novo Express','88214012', 100, 5, 9.98, 0, 114.98, 'CAD')
    `).run()
    const t = txn({ amount: -114.98, matched_type: 'receipt', matched_id: 'rec-1' })
    const d = buildEntryDraft(t, account(BNC))
    assert.equal(d.fields.tax.value, 14.98)
    assert.equal(d.fields.tax.source, 'facture 88214012')
    assert.equal(d.fields.doc_number.value, '88214012')
    assert.equal(d.fields.vendor.value, 'Novo Express')
    assert.deepEqual(d.document.tax_breakdown, { tps: 5, tvq: 9.98, autres: 0 })
  })

  it('le numéro de pièce est celui du chèque, jamais la référence bancaire', () => {
    const d = buildEntryDraft(txn({ description: 'CHEQUE NO', reference: 'Z0993312', check_number: '18' }), account(BNC))
    assert.equal(d.fields.doc_number.value, '18')
    assert.match(d.fields.doc_number.source, /chèque/)
  })

  it('un numéro de chèque ne transforme pas la sortie en chèque', () => {
    const d = buildEntryDraft(txn({ description: 'CHEQUE NO 18' }), account(BNC))
    assert.equal(d.fields.payment_method.value, 'Comptant')
  })

  it('une ligne de carte se paie par carte', () => {
    const d = buildEntryDraft(txn({ account_id: MCR }), account(MCR))
    assert.equal(d.fields.payment_method.value, 'Carte de crédit')
  })

  it('le montant d\'origine en devise devient un indice, avec son taux', () => {
    const t = txn({ amount: -54.51, description: 'WIX.COM SAN FRANCISCO CA USA CA Montant initial en devise USD 37,49' })
    const d = buildEntryDraft(t, account(BNC))
    assert.deepEqual(d.foreign, { currency: 'USD', amount: 37.49 })
    const hint = d.hints.find((h) => h.label === 'Montant d\'origine')
    assert.match(hint.value, /37\.49 USD/)
    assert.match(hint.value, /1\.45/)
  })

  it('la catégorie de la banque reste un indice, elle ne remplit aucun compte', () => {
    const d = buildEntryDraft(txn({ bank_category: 'Frais bancaires' }), account(BNC))
    assert.equal(d.fields.expense_account_id.value, null)
    assert.ok(d.hints.some((h) => h.value === 'Frais bancaires'))
  })

  it('une règle prime sur le profil et se nomme dans la source', () => {
    db.prepare('INSERT INTO vendor_profiles (id, name, default_expense_account_id) VALUES (?,?,?)')
      .run('vp-2', 'Novo Express', '5099')
    const d = buildEntryDraft(txn({ description: 'NOVO EXPRESS' }), account(BNC),
      { rule: { name: 'Transport', vendor_name: 'Novo Express', expense_account_id: '5300' } })
    assert.equal(d.fields.expense_account_id.value, '5300')
    assert.equal(d.fields.expense_account_id.source, 'règle « Transport »')
  })

  it('les conditions de paiement du profil donnent une échéance', () => {
    db.prepare('INSERT INTO vendor_profiles (id, name, default_expense_account_id, payment_terms_days, default_qb_type) VALUES (?,?,?,?,?)')
      .run('vp-3', 'Novo Express', '5010', 30, 'bill')
    const d = buildEntryDraft(txn({ description: 'NOVO EXPRESS' }), account(BNC))
    assert.equal(d.fields.qb_type.value, 'bill')
    assert.equal(d.fields.terms_days.value, 30)
    assert.equal(d.fields.due_date.value, '2026-10-01')
  })
})
