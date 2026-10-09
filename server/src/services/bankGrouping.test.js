// Regrouper des lignes du relevé, défaire le groupe, le refaire.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { groupTransactions, ungroupTransaction, regroupTransaction } from './bankGrouping.js'

const ACC = 'acct-grp'
const visible = () => db.prepare('SELECT id, amount FROM bank_transactions WHERE account_id=? AND deleted_at IS NULL ORDER BY id').all(ACC)
const add = (id, amount, extra = '') => db.prepare(`INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status${extra ? ', qb_txn_id' : ''})
  VALUES (?, ?, '2026-09-30', 'RONA CA BOUCHERVILLE QC', ?, ?, 'a_traiter'${extra ? ', ?' : ''})`).run(...[id, ACC, amount, `k-${id}`, ...(extra ? [extra] : [])])

describe('regroupement de lignes', () => {
  before(() => {
    initTestDb()
    db.prepare(`INSERT OR IGNORE INTO bank_accounts (id, name, currency) VALUES (?, 'Carte test', 'CAD')`).run(ACC)
    add('g1', 0.3); add('g2', 11.26); add('g3', 130.6)
    db.prepare(`INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status)
      VALUES ('gp', ?, '2026-10-01', 'RONA — 3 crédits', 142.16, 'k-gp', 'a_traiter')`).run(ACC)
  })

  it('rattache les lignes à une ligne existante au bon total, puis dégroupe et regroupe', () => {
    assert.throws(() => groupTransactions(['g1', 'g2'], { parentId: 'gp' }), /ne correspond pas/)
    groupTransactions(['g1', 'g2', 'g3'], { parentId: 'gp' })
    assert.deepEqual(visible().map((r) => r.id), ['gp'])
    ungroupTransaction('gp')
    assert.deepEqual(visible().map((r) => r.id), ['g1', 'g2', 'g3'])
    regroupTransaction('g2')
    assert.deepEqual(visible().map((r) => r.id), ['gp'])
  })

  it('crée la ligne groupée au total quand aucune n\'est donnée', () => {
    add('h1', -5); add('h2', -7.5)
    const { parent } = groupTransactions(['h1', 'h2'])
    assert.equal(parent.amount, -12.5)
    assert.match(parent.description, /2 lignes regroupées/)
  })

  it('refuse une ligne déjà comptabilisée', () => {
    add('i1', -1); add('i2', -2, 'qb-1')
    assert.throws(() => groupTransactions(['i1', 'i2']), /comptabilisée/)
  })
})
