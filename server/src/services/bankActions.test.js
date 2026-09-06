// Les deux gestes d'« Opérations bancaires » : comptabiliser une ligne sans
// facture, et apparier les deux moitiés d'un virement interne.
//
// Tests au niveau service (pas de serveur HTTP ouvert, donc rien à fermer) sur
// la DB jetable du harnais. Les migrations sont jouées explicitement : le
// harnais ne monte que schema.js, et `transfer_txn_id` vient de la 031. On
// applique CETTE migration seule : `runMigrations()` rejoue tout le registre,
// dont des reprises de données qui supposent des colonnes d'une base réelle.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { up as addTransferColumns } from '../db/migrations/031-bank-transfer-link.js'
import {
  BankActionError, addExpenseFromTxn, findTransferCandidates,
  linkTransfer, unlinkTransfer, pushTransferToQB, vendorHistory,
} from './bankActions.js'
import { deriveStatus } from './bankReconciliation.js'

const BNC = 'acct-bnc-cad'
const MCR = 'acct-mastercard'
const USD = 'acct-venn-usd'

let seq = 0
const nextId = () => `txn-${++seq}`

function seedAccounts() {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, qb_account_id)
    VALUES (?,?,?,?,?)
  `)
  ins.run(BNC, 'BNC CAD', 'bank', 'CAD', '35,999')
  ins.run(MCR, 'MasterCard BNC', 'card', 'CAD', '66')
  ins.run(USD, 'Venn USD', 'bank', 'USD', null)
}

function txn({ account_id = BNC, txn_date = '2026-09-01', amount = -100, details = 'PAIEMENT', ...rest } = {}) {
  const id = nextId()
  db.prepare(`
    INSERT INTO bank_transactions (id, account_id, txn_date, description, details, amount, dedup_key, status)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, account_id, txn_date, details, details, amount, `${id}-key`, rest.status || 'a_traiter')
  if (rest.qb_txn_id) db.prepare('UPDATE bank_transactions SET qb_txn_id=? WHERE id=?').run(rest.qb_txn_id, id)
  if (rest.matched_id) {
    db.prepare("UPDATE bank_transactions SET matched_type='achat', matched_id=? WHERE id=?").run(rest.matched_id, id)
  }
  if (rest.pending) db.prepare('UPDATE bank_transactions SET pending=1 WHERE id=?').run(id)
  return get(id)
}

const get = (id) => db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
const account = (id) => db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(id)

describe('bankActions', () => {
  before(() => {
    initTestDb()
    addTransferColumns(db)
    seedAccounts()
  })

  beforeEach(() => {
    db.exec('DELETE FROM bank_transactions')
    db.exec('DELETE FROM achats_fournisseurs')
  })

  describe('deriveStatus — virement', () => {
    it('une ligne appariée à sa contrepartie est « facture reçue »', () => {
      assert.equal(deriveStatus({ transfer_txn_id: 'x' }), 'facture_recue')
    })

    it('une fois l\'écriture QuickBooks posée, elle passe « comptabilisé »', () => {
      assert.equal(deriveStatus({ transfer_txn_id: 'x', qb_txn_id: '42' }), 'comptabilise')
    })

    it('« ignoré » et « rapproché » restent prioritaires', () => {
      assert.equal(deriveStatus({ transfer_txn_id: 'x', status: 'ignore' }), 'ignore')
      assert.equal(deriveStatus({ transfer_txn_id: 'x', reconciled_at: '2026-09-01' }), 'rapproche')
    })
  })

  describe('addExpenseFromTxn', () => {
    const body = { vendor: 'Hydro-Québec', expense_account_id: '5410', memo: 'Électricité' }

    it('crée un achat approuvé et y attache la ligne', () => {
      const t = txn({ amount: -123.45 })
      const { achatId } = addExpenseFromTxn(t, account(BNC), body, null)

      const achat = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(achatId)
      assert.equal(achat.type, 'purchase')
      assert.equal(achat.status, 'Approuvé')
      assert.equal(achat.vendor, 'Hydro-Québec')
      assert.equal(achat.total_cad, 123.45)
      assert.equal(achat.amount_cad, 123.45)
      assert.equal(achat.tax_cad, 0)
      assert.equal(achat.currency, 'CAD')
      assert.equal(achat.expense_account_id, '5410')
      assert.equal(achat.payment_account_id, '35', 'premier segment de qb_account_id')
      assert.equal(achat.payment_method, 'Comptant')
      assert.equal(achat.qb_memo, 'Électricité')

      const after = get(t.id)
      assert.equal(after.matched_type, 'achat')
      assert.equal(after.matched_id, achatId)
      assert.equal(after.match_method, 'manuel')
      assert.equal(after.status, 'facture_recue')
    })

    it('scinde le montant du relevé en HT + taxe', () => {
      const t = txn({ amount: -114.98 })
      const { achatId } = addExpenseFromTxn(t, account(BNC), { ...body, tax_code_id: 'TPS/TVQ', tax_cad: 14.98 }, null)
      const achat = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(achatId)
      assert.equal(achat.total_cad, 114.98)
      assert.equal(achat.tax_cad, 14.98)
      assert.equal(achat.amount_cad, 100)
      assert.equal(achat.tax_code_id, 'TPS/TVQ')
    })

    it('sur une carte, l\'écriture est payée par carte de crédit', () => {
      const t = txn({ account_id: MCR, amount: -50 })
      const { achatId } = addExpenseFromTxn(t, account(MCR), body, null)
      const achat = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(achatId)
      assert.equal(achat.payment_method, 'Carte de crédit')
      assert.equal(achat.payment_account_id, '66')
    })

    it('refuse une entrée d\'argent, une ligne déjà liée, une ligne en attente', () => {
      assert.throws(() => addExpenseFromTxn(txn({ amount: 80 }), account(BNC), body), BankActionError)
      assert.throws(() => addExpenseFromTxn(txn({ matched_id: 'a1' }), account(BNC), body), /déjà liée/)
      assert.throws(() => addExpenseFromTxn(txn({ pending: 1 }), account(BNC), body), /en attente/)
    })

    it('exige un fournisseur et un compte de dépense', () => {
      const t = txn()
      assert.throws(() => addExpenseFromTxn(t, account(BNC), { expense_account_id: '5410' }), /Fournisseur/)
      assert.throws(() => addExpenseFromTxn(t, account(BNC), { vendor: 'X' }), /Compte de dépense/)
    })

    it('refuse une taxe qui dépasse le montant du relevé', () => {
      const t = txn({ amount: -20 })
      assert.throws(
        () => addExpenseFromTxn(t, account(BNC), { ...body, tax_code_id: 'TPS/TVQ', tax_cad: 25 }),
        /taxe incohérent/,
      )
    })
  })

  describe('findTransferCandidates', () => {
    it('retient la ligne miroir d\'un autre compte', () => {
      const out = txn({ account_id: BNC, amount: -500, txn_date: '2026-09-01' })
      const back = txn({ account_id: MCR, amount: 500, txn_date: '2026-09-02' })
      const found = findTransferCandidates(out)
      assert.equal(found.length, 1)
      assert.equal(found[0].id, back.id)
      assert.equal(found[0].fx, false)
      assert.equal(found[0].account_name, 'MasterCard BNC')
    })

    it('écarte le même compte, le même sens, le montant différent, le hors-délai', () => {
      const out = txn({ account_id: BNC, amount: -500, txn_date: '2026-09-01' })
      txn({ account_id: BNC, amount: 500, txn_date: '2026-09-01' })   // même compte
      txn({ account_id: MCR, amount: -500, txn_date: '2026-09-01' })  // même sens
      txn({ account_id: MCR, amount: 499, txn_date: '2026-09-01' })   // montant ≠
      txn({ account_id: MCR, amount: 500, txn_date: '2026-09-20' })   // trop loin
      assert.equal(findTransferCandidates(out).length, 0)
    })

    it('écarte une ligne déjà liée ou exclue', () => {
      const out = txn({ account_id: BNC, amount: -500 })
      const ignored = txn({ account_id: MCR, amount: 500 })
      db.prepare("UPDATE bank_transactions SET status='ignore' WHERE id=?").run(ignored.id)
      assert.equal(findTransferCandidates(out).length, 0)
    })

    it('accepte une contrepartie en devise et la signale', () => {
      const out = txn({ account_id: USD, amount: -1000, txn_date: '2026-09-01' })
      txn({ account_id: BNC, amount: 1380, txn_date: '2026-09-01' })
      const found = findTransferCandidates(out)
      assert.equal(found.length, 1)
      assert.equal(found[0].fx, true)
    })
  })

  describe('linkTransfer', () => {
    it('pointe chaque ligne vers l\'autre et les passe en « facture reçue »', () => {
      const out = txn({ account_id: BNC, amount: -500 })
      const back = txn({ account_id: MCR, amount: 500 })
      linkTransfer(out, back)
      assert.equal(get(out.id).transfer_txn_id, back.id)
      assert.equal(get(back.id).transfer_txn_id, out.id)
      assert.equal(get(out.id).status, 'facture_recue')
      assert.equal(get(out.id).match_method, 'manuel')
    })

    it('refuse deux lignes du même compte, de même sens, ou de montants différents', () => {
      const out = txn({ account_id: BNC, amount: -500 })
      assert.throws(() => linkTransfer(out, txn({ account_id: BNC, amount: 500 })), /comptes différents/)
      assert.throws(() => linkTransfer(out, txn({ account_id: MCR, amount: -500 })), /sens opposé/)
      assert.throws(() => linkTransfer(out, txn({ account_id: MCR, amount: 400 })), /montants diffèrent/)
    })

    it('refuse de relier une ligne déjà liée', () => {
      const out = txn({ account_id: BNC, amount: -500 })
      const back = txn({ account_id: MCR, amount: 500 })
      linkTransfer(out, back)
      const third = txn({ account_id: MCR, amount: 500 })
      assert.throws(() => linkTransfer(get(out.id), third), (e) => e.status === 409)
    })

    it('exige le montant déclaré quand les devises diffèrent', () => {
      const out = txn({ account_id: USD, amount: -1000 })
      const back = txn({ account_id: BNC, amount: 1380 })
      assert.throws(() => linkTransfer(out, back), /Montant du virement requis/)
      linkTransfer(out, back, { amount: 1000 })
      assert.equal(get(out.id).transfer_amount, 1000)
    })

    it('se défait des deux côtés', () => {
      const out = txn({ account_id: BNC, amount: -500 })
      const back = txn({ account_id: MCR, amount: 500 })
      linkTransfer(out, back)
      unlinkTransfer(get(out.id))
      assert.equal(get(out.id).transfer_txn_id, null)
      assert.equal(get(back.id).transfer_txn_id, null)
      assert.equal(get(back.id).status, 'a_traiter')
    })
  })

  describe('pushTransferToQB', () => {
    it('envoie un Transfer du compte débité vers le compte crédité', async () => {
      const out = txn({ account_id: BNC, amount: -500, txn_date: '2026-09-03' })
      const back = txn({ account_id: MCR, amount: 500, txn_date: '2026-09-03' })
      linkTransfer(out, back)

      const sent = []
      const post = async (path, payload) => { sent.push([path, payload]); return { Transfer: { Id: '9001' } } }
      const r = await pushTransferToQB(get(out.id), get(back.id), { post })

      assert.equal(r.quickbooks_id, '9001')
      assert.equal(sent[0][0], '/transfer')
      assert.deepEqual(sent[0][1].FromAccountRef, { value: '35' })
      assert.deepEqual(sent[0][1].ToAccountRef, { value: '66' })
      assert.equal(sent[0][1].Amount, 500)
      assert.equal(sent[0][1].TxnDate, '2026-09-03')

      for (const id of [out.id, back.id]) {
        assert.equal(get(id).qb_txn_type, 'transfer')
        assert.equal(get(id).qb_txn_id, '9001')
        assert.equal(get(id).status, 'comptabilise')
      }
    })

    it('ne publie rien si un compte n\'est pas mappé à QuickBooks', async () => {
      const out = txn({ account_id: USD, amount: -1000 })
      const back = txn({ account_id: BNC, amount: 1380 })
      linkTransfer(out, back, { amount: 1000 })
      let called = false
      const r = await pushTransferToQB(get(out.id), get(back.id), { post: async () => { called = true } })
      assert.match(r.skipped, /pas mappé/)
      assert.equal(called, false)
    })

    it('ne publie rien si l\'écriture a déjà été retrouvée', async () => {
      const out = txn({ account_id: BNC, amount: -500, qb_txn_id: '777' })
      const back = txn({ account_id: MCR, amount: 500 })
      linkTransfer(out, back)
      const r = await pushTransferToQB(get(out.id), get(back.id), { post: async () => { throw new Error('ne doit pas être appelé') } })
      assert.match(r.skipped, /déjà retrouvée/)
    })
  })

  describe('vendorHistory', () => {
    const achat = (vendor, expense, tax, qbId) => {
      db.prepare(`
        INSERT INTO achats_fournisseurs (id, type, date_achat, vendor, status, total_cad, expense_account_id, tax_code_id, quickbooks_id, qb_memo)
        VALUES (?, 'purchase', '2026-08-01', ?, 'Approuvé', 100, ?, ?, ?, 'Frais mensuels')
      `).run(`a-${++seq}`, vendor, expense, tax, qbId)
    }

    it('ignore les achats jamais publiés', () => {
      achat('Twilio', '5410', 'TPS', null)
      assert.equal(vendorHistory('Twilio'), null)
    })

    it('classe les comptes par fréquence et signale une habitude constante', () => {
      achat('Twilio', '5410', 'TPS', '1')
      achat('Twilio', '5410', 'TPS', '2')
      const h = vendorHistory('Twilio')
      assert.equal(h.count, 2)
      assert.equal(h.expense_accounts[0].value, '5410')
      assert.equal(h.expense_accounts[0].n, 2)
      assert.equal(h.consistent, true)
      assert.equal(h.memos[0].value, 'Frais mensuels')
    })

    it('signale un historique qui se contredit', () => {
      achat('Twilio', '5410', 'TPS', '1')
      achat('Twilio', '5410', 'TPS', '2')
      achat('Twilio', '6240', 'TPS', '3')
      const h = vendorHistory('Twilio')
      assert.equal(h.consistent, false)
      assert.equal(h.expense_accounts[0].value, '5410')
      assert.equal(h.expense_accounts[1].value, '6240')
    })
  })
})
