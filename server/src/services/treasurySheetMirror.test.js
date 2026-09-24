import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTreasurySheet, sheetDate } from './treasurySheetMirrorPlan.js'

const text = stringValue => ({ userEnteredValue: { stringValue } })
const num = numberValue => ({ userEnteredValue: { numberValue } })
function template() {
  const rowData = Array.from({ length: 25 }, () => ({ values: Array.from({ length: 16 }, () => ({})) }))
  rowData[0].values = ['Fournisseur', 'Montant ($)', 'Date du paiement ', 'Solde disponible', '',
    'Solde disponible', 'Date', '', 'Sorties récurrentes', '', '', '', 'Paie', 'Montant aprox'].map(text)
  rowData[1].values.splice(8, 3, ...['Jour approx', 'Montant', 'Description'].map(text))
  rowData[1].values[0] = text('Ancienne sortie')
  rowData[1].values[1] = num(10)
  rowData[4].values[0] = text('Sortie périmée')
  rowData[4].values[3] = { userEnteredValue: { formulaValue: '=D4-B5' } }
  rowData[4].values[10] = text('Ancienne récurrente')
  rowData[6].values[13] = num(25000)
  rowData[20].values[5] = text('Note à conserver')
  return { properties: { sheetId: 0, gridProperties: { rowCount: 1002 } }, data: [{ rowData }] }
}
function projection() {
  return { balance_entry: { balance: 1000 }, balance_day: '2026-09-14', horizon_days: 7,
    days: [{ date: '2026-09-15', events: [
      { label: '=Un fournisseur', amount: -150.25, kind: 'bill' },
      { label: 'Stripe', amount: 20.15, kind: 'payout' },
      { label: 'Paie', amount: -200, kind: 'recurring', ref: 'pay' },
    ], balance: 669.90 }] }
}
const recurring = [{ id: 'pay', label: 'Paie', frequency: 'biweekly', amount: 250 }]
function apply(sheet, plan) {
  const copy = structuredClone(sheet)
  for (const request of plan.requests) {
    if (!request.updateCells) continue
    const { range, start, rows } = request.updateCells
    const r0 = range?.startRowIndex ?? start.rowIndex
    const c0 = range?.startColumnIndex ?? start.columnIndex
    rows.forEach((row, r) => row.values.forEach((v, c) => {
      const dest = copy.data[0].rowData[r0 + r].values[c0 + c]
      if (v.userEnteredValue) dest.userEnteredValue = v.userEnteredValue
      else delete dest.userEnteredValue
    }))
  }
  return copy
}

test('sorties positives, entrées négatives, formules chaînées et libellés littéraux', () => {
  const plan = planTreasurySheet(template(), projection(), recurring)
  const rows = plan.requests.find(r => r.updateCells?.range?.startColumnIndex === 0).updateCells.rows
  assert.deepEqual(rows[0].values[0], text('=Un fournisseur'))
  assert.deepEqual(rows[0].values[1], num(150.25))
  assert.deepEqual(rows[1].values[1], num(-20.15))
  assert.equal(rows[0].values[3].userEnteredValue.formulaValue, '=F2-B2')
  assert.equal(rows[2].values[3].userEnteredValue.formulaValue, '=D3-B4')
  assert.equal(plan.final_balance, 669.9)
})

test('nettoie les anciennes lignes sans toucher aux en-têtes, aux notes et aux formats', () => {
  const before = template()
  before.data[0].rowData[1].values[0].userEnteredFormat = { backgroundColor: { red: 1 } }
  const plan = planTreasurySheet(before, projection(), recurring)
  const after = apply(before, plan)
  assert.deepEqual(after.data[0].rowData[0], before.data[0].rowData[0])
  assert.deepEqual(after.data[0].rowData[20].values[5], text('Note à conserver'))
  assert.equal(after.data[0].rowData[4].values[0].userEnteredValue, undefined)
  assert.equal(after.data[0].rowData[6].values[13].userEnteredValue, undefined)
  assert.deepEqual(after.data[0].rowData[1].values[0].userEnteredFormat, { backgroundColor: { red: 1 } })
  assert.ok(plan.requests.filter(r => r.updateCells).every(r => r.updateCells.fields === 'userEnteredValue'))
})

test('deuxième passage identique : aucune écriture et aucun doublon', () => {
  const p = projection()
  const after = apply(template(), planTreasurySheet(template(), p, recurring))
  const second = planTreasurySheet(after, p, recurring)
  assert.deepEqual(second.requests, [])
  assert.equal(second.changed_cells, 0)
})

test('paie et récurrentes utilisent le montant appris de la projection et la vraie date du solde', () => {
  const after = apply(template(), planTreasurySheet(template(), projection(), recurring))
  assert.deepEqual(after.data[0].rowData[1].values[6], num(sheetDate('2026-09-14')))
  assert.deepEqual(after.data[0].rowData[1].values[13], num(200))
  assert.deepEqual(after.data[0].rowData[4].values[9], num(200))
})

test('modèle déplacé, solde absent, montant invalide ou total incohérent : refuse toute écriture', () => {
  const sheet = template()
  sheet.data[0].rowData[0].values[0] = text('Autre modèle')
  assert.throws(() => planTreasurySheet(sheet, projection()), /modèle/)
  assert.throws(() => planTreasurySheet(template(), { ...projection(), balance_entry: null }), /solde/)
  const invalid = projection(); invalid.days[0].events[0].amount = NaN
  assert.throws(() => planTreasurySheet(template(), invalid), /invalide/)
  const mismatch = projection(); mismatch.days[0].balance = 900
  assert.throws(() => planTreasurySheet(template(), mismatch), /incohérent/)
})

test('solde nul accepté et projection sans mouvements retire les anciennes sorties', () => {
  const p = { ...projection(), balance_entry: { balance: 0 }, days: [{ date: '2026-09-15', events: [], balance: 0 }] }
  const plan = planTreasurySheet(template(), p)
  assert.equal(plan.movements, 0)
  assert.equal(plan.final_balance, 0)
  assert.equal(apply(template(), plan).data[0].rowData[1].values[0].userEnteredValue, undefined)
})
