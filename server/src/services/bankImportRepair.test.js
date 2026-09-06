// Réparation des montants de l'import historique : le libellé (MasterCard,
// montant resté en devise étrangère) et le grand livre QB (Desjardins, montant
// remplacé par le solde). Tests au niveau service sur la DB jetable.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
// refreshStatuses lit transfer_txn_id : le harnais ne monte que schema.js, on
// applique CETTE migration seule (runMigrations rejoue tout le registre, dont
// des reprises qui supposent une base réelle).
import { up as addTransferColumns } from '../db/migrations/031-bank-transfer-link.js'
import { repairFromLabel, repairFromQbLedger, planRepair, applyRepair } from './bankImportRepair.js'

const MCR = 'acct-mcr'
const DESJ = 'acct-desj'

let seq = 0

function seedAccounts() {
  const ins = db.prepare(`
    INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency, qb_account_id)
    VALUES (?,?,?,?,?)
  `)
  ins.run(MCR, 'MasterCard BNC', 'card', 'CAD', null)
  ins.run(DESJ, 'Desjardins CAD', 'bank', 'CAD', null)
}

function txn({ account_id = MCR, txn_date = '2025-03-07', amount = -113, description = 'X', status = 'a_traiter' } = {}) {
  const id = `t-${++seq}`
  db.prepare(`
    INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, account_id, txn_date, description, amount, `${id}-key`, status)
  return db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
}

const get = (id) => db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)

describe('bankImportRepair', () => {
  before(() => { initTestDb(); addTransferColumns(db); seedAccounts() })
  beforeEach(() => { db.prepare('DELETE FROM bank_transactions').run() })

  describe('repairFromLabel', () => {
    it('lit le montant CAD en queue de libellé', () => {
      const fix = repairFromLabel({ amount: -100, description: 'HEMINGWAYAPP,COM   DURHAM   NC — -141.99' })
      assert.deepEqual(fix, { amount: -141.99, strategy: 'devise' })
    })

    it('conserve le signe de la ligne', () => {
      // Le relevé MasterCard note certains achats en positif : inverser
      // casserait detectSign et les lignes déjà liées.
      const fix = repairFromLabel({ amount: 12.61, description: 'AMAZON,CA — -20.00' })
      assert.equal(fix.amount, 20)
    })

    it('ne propose rien quand le libellé dit la même chose', () => {
      assert.equal(repairFromLabel({ amount: -10000, description: 'PAIEMENT RECU MERCI — 10000' }), null)
      assert.equal(repairFromLabel({ amount: 12.61, description: 'AMAZON,CA — -12.61' }), null)
    })

    it('ne propose rien sans suffixe', () => {
      assert.equal(repairFromLabel({ amount: -100, description: 'Dépôt provenant de marge de crédit' }), null)
      assert.equal(repairFromLabel({ amount: -100, description: null }), null)
    })
  })

  describe('repairFromQbLedger', () => {
    const t = { txn_date: '2025-01-10', amount: 48869.66 }

    it('prend le montant de l’unique écriture du jour', () => {
      const fix = repairFromQbLedger(t, [
        { date: '2025-01-09', entity: 'transfer', qbId: '12444', amount: 2000 },
        { date: '2025-01-10', entity: 'deposit', qbId: '12445', amount: 48245 },
      ])
      assert.equal(fix.amount, 48245)
      assert.equal(fix.strategy, 'solde')
      assert.equal(fix.qb.qbId, '12445')
    })

    it('renonce si deux écritures partagent la date', () => {
      assert.equal(repairFromQbLedger(t, [
        { date: '2025-01-10', entity: 'deposit', qbId: 'a', amount: 48245 },
        { date: '2025-01-10', entity: 'deposit', qbId: 'b', amount: 100 },
      ]), null)
    })

    it('renonce si aucune écriture ce jour-là', () => {
      assert.equal(repairFromQbLedger(t, [{ date: '2025-01-09', entity: 'deposit', qbId: 'a', amount: 48245 }]), null)
    })

    it('renonce quand le montant est déjà le bon', () => {
      assert.equal(repairFromQbLedger({ txn_date: '2025-01-10', amount: 48245 },
        [{ date: '2025-01-10', entity: 'deposit', qbId: 'a', amount: 48245 }]), null)
    })
  })

  describe('planRepair', () => {
    it('ne touche jamais une ligne rapprochée', async () => {
      txn({ amount: -113, description: 'STICKER MULE — -166.73', status: 'rapproche' })
      const plan = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      assert.equal(plan.rows.length, 0)
      assert.equal(plan.scanned, 0)
    })

    it('ignore ce qui est hors fenêtre', async () => {
      txn({ txn_date: '2026-03-07', description: 'STICKER MULE — -166.73' })
      const plan = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      assert.equal(plan.rows.length, 0)
    })

    it('met le grand livre en veille tant que le libellé a du travail', async () => {
      // Le compte est mappé QB : si la stratégie « solde » se déclenchait, elle
      // appellerait QuickBooks. Le test échouerait — c'est le but.
      db.prepare('UPDATE bank_accounts SET qb_account_id=? WHERE id=?').run('66', MCR)
      txn({ description: 'STICKER MULE — -166.73' })
      txn({ description: 'Sans suffixe' })
      const plan = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      db.prepare('UPDATE bank_accounts SET qb_account_id=NULL WHERE id=?').run(MCR)
      assert.equal(plan.rows.length, 1)
      assert.equal(plan.rows[0].strategy, 'devise')
    })

    it('renonce quand deux lignes du relevé partagent la date', async () => {
      // Sinon la même écriture QB serait recopiée sur les deux.
      db.prepare('UPDATE bank_accounts SET qb_account_id=? WHERE id=?').run('236', DESJ)
      txn({ account_id: DESJ, txn_date: '2024-12-19', amount: 10, description: 'A' })
      txn({ account_id: DESJ, txn_date: '2024-12-19', amount: 20, description: 'B' })
      const ledger = async () => [{ date: '2024-12-19', entity: 'deposit', qbId: '1', amount: 71.37 }]
      const plan = await planRepair(DESJ, { from: '2024-01-01', to: '2025-12-31', fetchLedger: ledger })
      db.prepare('UPDATE bank_accounts SET qb_account_id=NULL WHERE id=?').run(DESJ)
      assert.equal(plan.rows.length, 0)
    })

    it('laisse tranquille une ligne dont le libellé confirme le montant', async () => {
      db.prepare('UPDATE bank_accounts SET qb_account_id=? WHERE id=?').run('66', DESJ)
      txn({ account_id: DESJ, txn_date: '2025-01-13', amount: -208.48, description: 'MCMASTER-CARR — -208.48' })
      const ledger = async () => [{ date: '2025-01-13', entity: 'expense', qbId: '12581', amount: -138.48 }]
      const plan = await planRepair(DESJ, { from: '2024-01-01', to: '2025-12-31', fetchLedger: ledger })
      db.prepare('UPDATE bank_accounts SET qb_account_id=NULL WHERE id=?').run(DESJ)
      assert.equal(plan.rows.length, 0)
    })

    it('propose les lignes en devise et compte les autres', async () => {
      const a = txn({ description: 'STICKER MULE — -166.73' })
      txn({ description: 'BUREAU EN GROS — -113' })
      const plan = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      assert.equal(plan.rows.length, 1)
      assert.equal(plan.rows[0].id, a.id)
      assert.equal(plan.rows[0].new_amount, -166.73)
      assert.equal(plan.skipped, 1)
    })
  })

  describe('applyRepair', () => {
    it('écrit le montant, garde l’ancien dans le solde, et lie l’écriture QB', async () => {
      const a = txn({ account_id: DESJ, txn_date: '2025-01-10', amount: 48869.66, description: 'Paiement fédéral' })
      const plan = {
        account: { id: DESJ },
        rows: [{ id: a.id, amount: a.amount, new_amount: 48245, strategy: 'solde', qb: { entity: 'deposit', qbId: '12445' } }],
      }
      const out = applyRepair(plan)
      assert.equal(out.repaired, 1)
      assert.equal(out.linked, 1)
      const after = get(a.id)
      assert.equal(after.amount, 48245)
      assert.equal(after.balance, 48869.66)
      assert.equal(after.qb_txn_id, '12445')
      assert.equal(after.qb_txn_type, 'deposit')
      assert.equal(after.qb_match_method, 'manuel')
      assert.equal(after.status, 'comptabilise')
    })

    it('est sans effet à la seconde passe', async () => {
      const a = txn({ description: 'STICKER MULE — -166.73' })
      const plan = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      applyRepair(plan)
      const again = await planRepair(MCR, { from: '2024-01-01', to: '2025-12-31' })
      assert.equal(again.rows.length, 0)
      assert.equal(get(a.id).amount, -166.73)
    })
  })
})
