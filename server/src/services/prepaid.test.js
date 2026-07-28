import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSchedule, fiscalMonths, classifyQbTxn, entrySign, diffLedgerVsQb } from './prepaid.js'

// ── computeSchedule ──────────────────────────────────────────────────────────

test('prorata_jours : cas Intact du fichier FPA_Continuité (3 835 $ sur 223 jours)', () => {
  // Formule documentée du fichier : montant × nb jours du mois / 223 jours.
  // Avril (30 j) = 515,92 ; le dernier mois (nov., 9 j) absorbe le résidu.
  // Total exactement 3 835,00.
  const sched = computeSchedule({
    method: 'prorata_jours', amount: 3835, amort_start: '2026-04-01', amort_end: '2026-11-09',
  })
  assert.equal(sched.length, 8)
  assert.deepEqual(sched[0], { month: '2026-04', amount: 515.92 })
  assert.equal(sched[7].month, '2026-11')
  const total = sched.reduce((s, m) => s + m.amount, 0)
  assert.equal(Math.round(total * 100) / 100, 3835)
})

test('prorata_jours : le dernier mois absorbe le résidu d\'arrondi', () => {
  const sched = computeSchedule({
    method: 'prorata_jours', amount: 100, amort_start: '2026-01-01', amort_end: '2026-03-31',
  })
  assert.equal(sched.length, 3)
  assert.equal(Math.round(sched.reduce((s, m) => s + m.amount, 0) * 100) / 100, 100)
})

test('prorata_jours : période sur un seul mois → tout le montant ce mois-là', () => {
  const sched = computeSchedule({
    method: 'prorata_jours', amount: 500, amort_start: '2026-06-05', amort_end: '2026-06-20',
  })
  assert.deepEqual(sched, [{ month: '2026-06', amount: 500 }])
})

test('méthode manuel/aucun ou bornes manquantes → cédule calculée vide', () => {
  assert.deepEqual(computeSchedule({ method: 'manuel', amount: 100 }), [])
  assert.deepEqual(computeSchedule({ method: 'aucun', amount: 100, amort_start: '2026-01-01', amort_end: '2026-02-01' }), [])
  assert.deepEqual(computeSchedule({ method: 'prorata_jours', amount: 100, amort_start: '2026-01-01' }), [])
  assert.deepEqual(computeSchedule({ method: 'prorata_jours', amount: 100, amort_start: '2026-03-01', amort_end: '2026-01-01' }), [])
})

// ── fiscalMonths ─────────────────────────────────────────────────────────────

test('exercice fiscal avril → mars', () => {
  const months = fiscalMonths(2026)
  assert.equal(months.length, 12)
  assert.equal(months[0], '2026-04')
  assert.equal(months[8], '2026-12')
  assert.equal(months[9], '2027-01')
  assert.equal(months[11], '2027-03')
})

// ── classifyQbTxn ────────────────────────────────────────────────────────────

test('Bill → facture, VendorCredit → ajustement, Purchase par défaut → recharge', () => {
  assert.equal(classifyQbTxn('Bill', {}), 'facture')
  assert.equal(classifyQbTxn('VendorCredit', {}), 'ajustement')
  assert.equal(classifyQbTxn('Purchase', {}), 'recharge')
})

test('Purchase avec compte d\'actif configuré : position du compte décide', () => {
  // Payé DEPUIS l'actif prépayé (facture de consommation : Dr dépense / Cr actif).
  assert.equal(classifyQbTxn('Purchase', { AccountRef: { value: '88' }, Line: [] }, '88'), 'facture')
  // Catégorisé VERS l'actif prépayé (recharge : Dr actif / Cr carte).
  assert.equal(classifyQbTxn('Purchase', {
    AccountRef: { value: '12' },
    Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: '88' } } }],
  }, '88'), 'recharge')
  // Aucun des deux → défaut recharge (reclassable dans l'UI).
  assert.equal(classifyQbTxn('Purchase', { AccountRef: { value: '12' }, Line: [] }, '88'), 'recharge')
})

// ── entrySign ────────────────────────────────────────────────────────────────

test('signe des entrées : recharge +, facture −, ajustement signé tel quel', () => {
  assert.equal(entrySign({ type: 'recharge', amount: 500 }), 500)
  assert.equal(entrySign({ type: 'facture', amount: 677.47 }), -677.47)
  assert.equal(entrySign({ type: 'ajustement', amount: -143.69 }), -143.69)
  assert.equal(entrySign({ type: 'ajustement', amount: 26.64 }), 26.64)
})

// ── diffLedgerVsQb (audit de complétude) ─────────────────────────────────────

const qbTxn = (type, id, date, amount) => ({ qb_txn_type: type, qb_txn_id: id, entry_date: date, amount, type: 'facture', description: `${type} #${id}` })
const erpEntry = (type, id, date, amount, extra = {}) => ({ id: `e-${id}`, qb_txn_type: type, qb_txn_id: id, entry_date: date, amount, ...extra })

test('diffLedgerVsQb : ledger identique à QB → tout concorde', () => {
  const qb = [qbTxn('Purchase', '1', '2026-07-01', 20), qbTxn('Bill', '2', '2026-07-05', 103.48)]
  const erp = [erpEntry('Purchase', '1', '2026-07-01', 20), erpEntry('Bill', '2', '2026-07-05', 103.48)]
  const d = diffLedgerVsQb(erp, qb)
  assert.equal(d.matched, 2)
  assert.deepEqual([d.missing.length, d.mismatched.length, d.orphaned.length], [0, 0, 0])
})

test('diffLedgerVsQb : transaction QB absente du ledger → missing', () => {
  const d = diffLedgerVsQb([], [qbTxn('Bill', '9', '2026-07-10', 50)])
  assert.equal(d.missing.length, 1)
  assert.equal(d.missing[0].qb_txn_id, '9')
})

test('diffLedgerVsQb : montant ou date modifié dans QB → mismatched', () => {
  const qb = [qbTxn('Purchase', '1', '2026-07-01', 25), qbTxn('Purchase', '2', '2026-07-03', 10)]
  const erp = [erpEntry('Purchase', '1', '2026-07-01', 20), erpEntry('Purchase', '2', '2026-07-02', 10)]
  const d = diffLedgerVsQb(erp, qb)
  assert.equal(d.mismatched.length, 2)
  assert.equal(d.mismatched[0].amount_differs, true)
  assert.equal(d.mismatched[1].date_differs, true)
})

test('diffLedgerVsQb : entrée ERP dont la transaction QB a disparu → orphaned', () => {
  const d = diffLedgerVsQb([erpEntry('Purchase', '7', '2026-07-01', 20)], [])
  assert.equal(d.orphaned.length, 1)
  assert.equal(d.orphaned[0].id, 'e-7')
})

test('diffLedgerVsQb : le type reclassé à la main ne compte pas comme écart', () => {
  const qb = [{ ...qbTxn('Purchase', '1', '2026-07-01', 20), type: 'recharge' }]
  const erp = [{ ...erpEntry('Purchase', '1', '2026-07-01', 20), type: 'facture' }]
  const d = diffLedgerVsQb(erp, qb)
  assert.equal(d.matched, 1)
})

test('diffLedgerVsQb : VendorCredit négatif comparé en valeur absolue', () => {
  const d = diffLedgerVsQb(
    [erpEntry('VendorCredit', '3', '2026-07-01', -15)],
    [qbTxn('VendorCredit', '3', '2026-07-01', -15)],
  )
  assert.equal(d.matched, 1)
})
