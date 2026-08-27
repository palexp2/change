// Générateur de cédule d'amortissement — vérifié contre les calendriers
// officiels des deux prêteurs. Ces deux cédules sont la référence : si le
// générateur dérive d'une cenne, les écritures de versement poussées dans QB
// ne concordent plus avec les relevés du prêteur.

import test from 'node:test'
import assert from 'node:assert/strict'
import { generateSchedule } from './ltDebtSchedule.js'

// Calendrier de remboursement 12868 de la Ville de Québec (FLI 250 k$ à 6,5 %),
// solde d'ouverture après le moratoire d'intérêts capitalisés.
const VILLE_QC = {
  opening_balance: 258235.83,
  annual_rate: 6.5,
  frequency: 'monthly',
  payment_amount: 4664.11,
  first_payment_date: '2026-02-11',
}

test('Ville de Québec — 66 versements, premier / dernier conformes au calendrier officiel', () => {
  const { rows, error, totals } = generateSchedule(VILLE_QC)
  assert.equal(error, null)
  assert.equal(totals.count, 66)
  assert.deepEqual(rows[0], {
    payment_date: '2026-02-11', principal: 3265.33, interest: 1398.78, balance_after: 254970.50,
  })
  assert.deepEqual(rows[1], {
    payment_date: '2026-03-11', principal: 3283.02, interest: 1381.09, balance_after: 251687.48,
  })
  // Le solde de la cédule au 2026-07-11 est celui du compte QB #27500.
  assert.equal(rows.find(r => r.payment_date === '2026-07-11').balance_after, 238376.61)
  // Dernier versement : le prêteur y replie la dérive d'arrondi (4 664,27 $).
  const last = rows[rows.length - 1]
  assert.equal(last.payment_date, '2031-07-11')
  assert.equal(Math.round((last.principal + last.interest) * 100) / 100, 4664.27)
  assert.equal(last.balance_after, 0)
  assert.equal(totals.principal, 258235.83)
})

test('DEC — 72 versements sans intérêt qui totalisent exactement 200 000 $', () => {
  const { rows, error, totals } = generateSchedule({
    opening_balance: 200000, annual_rate: 0, frequency: 'monthly',
    payment_amount: 2777.78, first_payment_date: '2028-11-01',
  })
  assert.equal(error, null)
  assert.equal(totals.count, 72)
  assert.equal(totals.interest, 0)
  assert.equal(totals.principal, 200000)
  assert.equal(rows[0].payment_date, '2028-11-01')
  assert.equal(rows[70].payment_date, '2034-09-01')
  assert.deepEqual(rows[71], {
    payment_date: '2034-10-01', principal: 2777.62, interest: 0, balance_after: 0,
  })
})

test('un versement qui ne couvre pas les intérêts est refusé, pas bouclé à l’infini', () => {
  const { error } = generateSchedule({ ...VILLE_QC, payment_amount: 100 })
  assert.match(error, /ne couvre pas les intérêts/)
})

test('nombre de versements sans montant → annuité calculée', () => {
  const { rows, error } = generateSchedule({
    opening_balance: 12000, annual_rate: 12, frequency: 'monthly',
    n_payments: 12, first_payment_date: '2026-01-15',
  })
  assert.equal(error, null)
  assert.equal(rows.length, 12)
  assert.equal(rows[rows.length - 1].balance_after, 0)
  assert.equal(rows[0].interest, 120) // 12 000 × 12 % / 12
})

test('cadence trimestrielle et quantième borné à la fin du mois', () => {
  const { rows } = generateSchedule({
    opening_balance: 9000, annual_rate: 0, frequency: 'quarterly',
    payment_amount: 3000, first_payment_date: '2026-01-31',
  })
  assert.deepEqual(rows.map(r => r.payment_date), ['2026-01-31', '2026-04-30', '2026-07-31'])
})

test('paramètres invalides → message d’erreur, jamais de cédule partielle', () => {
  for (const patch of [
    { opening_balance: 0 },
    { annual_rate: -1 },
    { frequency: 'yearly' },
    { first_payment_date: '11-02-2026' },
    { payment_amount: null, n_payments: null },
  ]) {
    const { rows, error } = generateSchedule({ ...VILLE_QC, ...patch })
    assert.ok(error, `attendu une erreur pour ${JSON.stringify(patch)}`)
    assert.deepEqual(rows, [])
  }
})
