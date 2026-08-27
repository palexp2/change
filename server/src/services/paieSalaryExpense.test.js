import { test } from 'node:test'
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { computePaieSalaryExpense } from './paieSalaryExpense.js'

// Paie jetable, calcul d'aperçu (aucune écriture QB), puis nettoyage.
test('computePaieSalaryExpense : réplique la dépense QB « Salaires » historique', () => {
  const paieId = 'test-paie-salary-expense'
  const empId = 'test-emp-martin-phone'
  const itemId = 'test-paie-item-martin-phone'
  db.prepare(`INSERT OR REPLACE INTO paies (id, period_start, period_end) VALUES (?, '2026-06-21', '2026-07-04')`).run(paieId)
  // Le remboursement « téléphone Martin » (25 $) arrive DANS les items de la
  // paie — il doit devenir la ligne téléphone (76000), pas une ligne de
  // remboursement en plus (jamais compté en double).
  db.prepare(`INSERT OR REPLACE INTO employees (id, first_name, last_name) VALUES (?, 'Martin', 'Test')`).run(empId)
  db.prepare(`INSERT OR REPLACE INTO paie_items (id, paie_id, employee_id, expense_reimb) VALUES (?, ?, ?, 25)`).run(itemId, paieId, empId)
  try {
    // Le 25 $ du téléphone est TAXES INCLUSES : seuls les 25 $ sortent de la
    // base des salaires, jamais la taxe (elle est extraite du 25 $ à la
    // publication). Le total de la dépense reste égal au débit bancaire.
    const p = computePaieSalaryExpense(paieId, { bank_amount: 23570.19, txn_date: '2026-07-07' })
    assert.equal(p.deductions.phone_tax, 0)
    assert.equal(p.deductions.phone_gross, 25)
    assert.equal(p.base, 23545.19)
    assert.equal(p.total, 23570.19)
    assert.equal(p.memo, 'Paie – 2026-06-21 au 2026-07-04')
    const salaries = p.lines.filter(l => l.kind === 'salary')
    assert.equal(salaries.reduce((s, l) => s + l.amount, 0), 23545.19)
    assert.ok(salaries.every(l => l.description === '2026-06-21 au 2026-07-04'))
    const phone = p.lines.find(l => l.kind === 'phone')
    assert.equal(phone.amount, 25)
    assert.equal(phone.tax, 0)
    assert.equal(phone.tax_included, true)
    assert.equal(phone.acctnum, '76000')
    assert.match(phone.taxcode, /TPS\/TVQ/)
    assert.match(phone.description, /Téléphone Martin/)
    // Une seule fois : pas de ligne « Remboursement des dépenses » pour Martin.
    assert.equal(p.lines.filter(l => l.kind === 'reimb').length, 0)
    assert.equal(p.reimb_total, 0)

    assert.throws(() => computePaieSalaryExpense(paieId, {}), /Montant passé au compte de banque requis/)
    assert.throws(() => computePaieSalaryExpense(paieId, { bank_amount: 10 }), /nulle ou négative/)
  } finally {
    db.prepare('DELETE FROM paie_items WHERE id=?').run(itemId)
    db.prepare('DELETE FROM employees WHERE id=?').run(empId)
    db.prepare('DELETE FROM paies WHERE id=?').run(paieId)
  }
})

// Paie sans remboursement téléphone : aucune ligne téléphone inventée, mais un
// avertissement puisque le remboursement de Martin est normalement mensuel.
test('computePaieSalaryExpense : pas de ligne téléphone sans remboursement Martin', () => {
  const paieId = 'test-paie-salary-expense-no-phone'
  db.prepare(`INSERT OR REPLACE INTO paies (id, period_start, period_end) VALUES (?, '2019-07-05', '2019-07-18')`).run(paieId)
  try {
    const p = computePaieSalaryExpense(paieId, { bank_amount: 20000, txn_date: '2019-07-21' })
    assert.equal(p.phone, 0)
    assert.equal(p.lines.filter(l => l.kind === 'phone').length, 0)
    assert.equal(p.base, 20000)
    assert.ok(p.warnings.some(w => /téléphone de Martin/.test(w)), 'avertissement mensuel attendu')
  } finally {
    db.prepare('DELETE FROM paies WHERE id=?').run(paieId)
  }
})
