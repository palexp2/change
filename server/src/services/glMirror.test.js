import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { parseJournalReport, entryIssues, txnTypeOf, monthsBetween, monthBounds, entityFromPath, glChangesFromCdc, monthsForMutation, fiscalYearStart } from './glMirror.js'

// Extrait anonymisé du JournalReport réel (septembre 2026).
const REPORT = JSON.parse(readFileSync(new URL('./__fixtures__/journalReport.sample.json', import.meta.url)))

test('une transaction par en-tête, lignes de suite rattachées', () => {
  const { entries, anomalies } = parseJournalReport(REPORT)
  assert.deepEqual(anomalies, [])
  assert.deepEqual(entries.map(e => [e.id, e.lines.length]), [
    ['BillPayment:17951', 2], ['Deposit:17955', 4], ['JournalEntry:18001', 2], ['Bill:17970', 6],
  ])
  const dep = entries[1]
  assert.equal(dep.txn_date, '2026-09-01')
  assert.equal(dep.txn_label, 'Dépôt')
  assert.equal(dep.name, 'Tiers 2')
  assert.deepEqual(dep.lines[0], {
    line_no: 1, account_qb_id: '61', account_label: '10000 Compte chèques Banque Nationale', acct_num: '10000',
    debit: 8853.1, credit: 0, memo: 'Mémo 1', name: 'Tiers 2',
  })
  assert.equal(dep.lines[2].account_qb_id, '63')
  assert.equal(dep.lines[2].name, null)
})

test('lignes de total ignorées, total du rapport lu à part', () => {
  const { entries, total } = parseJournalReport(REPORT)
  assert.deepEqual(total, { debit: 9406.59, credit: 9406.59 })
  for (const e of entries) {
    assert.ok(e.summary, e.id)
    assert.deepEqual(entryIssues(e), [], e.id)
  }
})

test('transaction déséquilibrée signalée, pas corrigée', () => {
  const r = JSON.parse(JSON.stringify(REPORT))
  r.Rows.Row[1].ColData[8].value = '100.00'
  const e = parseJournalReport(r).entries[0]
  assert.equal(e.lines[1].debit, 100)
  const issues = entryIssues(e)
  assert.equal(issues.length, 2)
  assert.match(issues[0], /déséquilibrée/)
})

test('types : libellé français → entité QBO, inconnu conservé', () => {
  assert.equal(txnTypeOf('Dépense'), 'Purchase')
  assert.equal(txnTypeOf('Chèque'), 'Purchase')
  assert.equal(txnTypeOf('Valeur de départ du stock'), 'Valeur de départ du stock')
})

test('mois : bornes et énumération', () => {
  assert.deepEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' })
  assert.deepEqual(monthsBetween('2025-11-15', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
})

test('chemin d\'une écriture Boréal → entité du grand livre', () => {
  assert.equal(entityFromPath('/journalentry'), 'JournalEntry')
  assert.equal(entityFromPath('/purchase?operation=delete'), 'Purchase')
  assert.equal(entityFromPath('/account'), 'Account')
  assert.equal(entityFromPath('/customer'), null)
  assert.equal(entityFromPath('/upload'), null)
})

test('mois salis par une écriture Boréal : mois courant + date du corps et de la réponse', () => {
  assert.deepEqual(monthsForMutation({ body: { TxnDate: '2026-08-31' } }, 'JournalEntry', '2026-10'), ['2026-10', '2026-08'])
  assert.deepEqual(monthsForMutation({ response: { Deposit: { TxnDate: '2026-10-02' } } }, 'Deposit', '2026-10'), ['2026-10'])
  assert.deepEqual(monthsForMutation({ body: { TxnDate: 'n/a' } }, 'Bill', '2026-10'), ['2026-10'])
})

test('réponse CDC → changements du grand livre (supprimés compris, entités hors GL ignorées)', () => {
  const data = { CDCResponse: [{ QueryResponse: [
    { Invoice: [{ Id: '12', TxnDate: '2026-09-30', MetaData: { LastUpdatedTime: 't1' } }], startPosition: 1 },
    { Purchase: [{ Id: '7', status: 'Deleted', MetaData: { LastUpdatedTime: 't2' } }] },
    { Customer: [{ Id: '3' }] },
    { Account: [{ Id: '61' }] },
  ] }] }
  assert.deepEqual(glChangesFromCdc(data), [
    { name: 'Invoice', id: '12', deleted: false, txnDate: '2026-09-30', lastUpdated: 't1' },
    { name: 'Purchase', id: '7', deleted: true, txnDate: null, lastUpdated: 't2' },
    { name: 'Account', id: '61', deleted: false, txnDate: null, lastUpdated: null },
  ])
})

test('exercice : commence en avril', () => {
  assert.equal(fiscalYearStart('2026-10-16'), '2026-04-01')
  assert.equal(fiscalYearStart('2026-03-31'), '2025-04-01')
  assert.equal(fiscalYearStart('2026-04-01'), '2026-04-01')
})
