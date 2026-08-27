import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPostingGroups, buildChargeLines, buildGstOnlyLines, buildGstTaxDetail } from './carmQb.js'

const IDS = { ap: '93', duty: '24', interest: '28', penalty: '29', card: '66', tps: '5', noTax: '2', tpsRate: '7', vendor: '1013' }
const line = o => ({ posting_state: 'a_comptabiliser', transaction_date: '2026-07-09', ...o })
const groups = (lines, opts = { tolerance: 0.02 }) => buildPostingGroups(lines, opts)

test('un B3 en deux lignes (droits + TPS) donne une seule facture', () => {
  const g = groups([
    line({ id: 'a', transaction_number: 'B3-1', amount: 47.71, kind: 'droits', duty_amount: 47.71, gst_amount: 0 }),
    line({ id: 'b', transaction_number: 'B3-1', amount: 228.29, kind: 'tps', duty_amount: 0, gst_amount: 228.29 }),
  ])
  assert.equal(g.length, 1)
  assert.deepEqual(
    { total: g[0].total, duty: g[0].duty, gst: g[0].gst, blockers: g[0].blockers },
    { total: 276, duty: 47.71, gst: 228.29, blockers: [] })
})

test('un versement éclaté par l’ASFC donne une seule dépense du montant bancaire', () => {
  const g = groups([
    line({ id: 'p1', transaction_date: '2026-08-03', transaction_number: 'LD-1', amount: -297.32, kind: 'paiement', payer: 'nous' }),
    line({ id: 'p2', transaction_date: '2026-08-03', transaction_number: 'LD-1', amount: -202.68, kind: 'paiement', payer: 'nous' }),
  ])
  assert.equal(g.length, 1)
  assert.equal(g[0].type, 'paiement')
  assert.equal(g[0].total, 500)
})

test('une ligne non ventilée bloque son groupe', () => {
  const g = groups([line({ id: 'a', transaction_number: 'B3-2', amount: 345.10, kind: 'evaluation' })])
  assert.equal(g[0].blockers.length, 1)
  assert.match(g[0].blockers[0], /à ventiler/)
})

test('une ventilation qui ne balance pas bloque le groupe', () => {
  const g = groups([line({ id: 'a', transaction_number: 'B3-3', amount: 100, kind: 'tps', duty_amount: 0, gst_amount: 90 })])
  assert.match(g[0].blockers[0], /90.00 \$ pour 100.00 \$/)
})

test('les charges d’un courtier et les lignes déjà comptabilisées sont hors lot', () => {
  const g = groups([
    line({ id: 'a', amount: -50, kind: 'paiement', payer: 'courtier', broker: 'FedEx' }),
    line({ id: 'b', amount: 50, kind: 'tps', duty_amount: 0, gst_amount: 50, posting_state: 'comptabilise' }),
    line({ id: 'c', amount: 10, kind: 'tps', duty_amount: 0, gst_amount: 10, posting_state: 'attente_imputation' }),
  ])
  assert.deepEqual(g, [])
})

test('correction créditrice → note de crédit, jamais mélangée aux factures', () => {
  const g = groups([
    line({ id: 'a', transaction_number: 'X', amount: 100, kind: 'tps', duty_amount: 0, gst_amount: 100 }),
    line({ id: 'b', transaction_number: 'X', amount: -40, kind: 'tps', duty_amount: 0, gst_amount: -40 }),
  ])
  assert.deepEqual(g.map(x => x.type).sort(), ['charge', 'credit'])
})

test('charge 100 % TPS : lignes +0,01 / −0,01 et taxe figée', () => {
  const lines = buildChargeLines({ duty: 0, gst: 12.34, interest: 0, penalty: 0 }, IDS)
  assert.deepEqual(lines.map(l => l.Amount), [0.01, -0.01])
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, IDS.tps)
  assert.equal(lines[1].AccountBasedExpenseLineDetail.TaxCodeRef.value, IDS.noTax)
  const tax = buildGstTaxDetail(12.34, IDS)
  assert.equal(tax.TotalTax, 12.34)
  assert.equal(tax.TaxLine[0].TaxLineDetail.NetAmountTaxable, 246.8) // valeur en douane = TPS / 5 %
})

test('charge droits + TPS : la ligne de droits porte le code TPS (QB refuse sinon)', () => {
  const lines = buildChargeLines({ duty: 47.71, gst: 228.29, interest: 0, penalty: 0 }, IDS)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Amount, 47.71)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, IDS.duty)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, IDS.tps)
})

test('droits sans TPS : la ligne reste hors champ', () => {
  const lines = buildChargeLines({ duty: 20, gst: 0, interest: 0, penalty: 0 }, IDS)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, IDS.noTax)
  assert.equal(buildGstTaxDetail(0, IDS), null)
})

test('intérêts et pénalités vont sur leurs comptes, hors champ', () => {
  const lines = buildChargeLines({ duty: 0, gst: 0, interest: 1.46, penalty: 50 }, IDS)
  assert.deepEqual(lines.map(l => [l.Amount, l.AccountBasedExpenseLineDetail.AccountRef.value]),
    [[1.46, IDS.interest], [50, IDS.penalty]])
  assert.ok(lines.every(l => l.AccountBasedExpenseLineDetail.TaxCodeRef.value === IDS.noTax))
})

test('l’astuce 0,01 / −0,01 a une somme nulle : le total vaut la taxe', () => {
  const lines = buildGstOnlyLines(IDS.duty, IDS.tps, IDS.noTax)
  assert.equal(lines.reduce((s, l) => s + l.Amount, 0), 0)
})

test('une évaluation devient comptabilisable dès qu’elle est ventilée à la main', () => {
  const g = groups([line({ id: 'a', transaction_number: 'B3-4', amount: 345.10, kind: 'evaluation', duty_amount: 0, gst_amount: 345.10 })])
  assert.deepEqual(g[0].blockers, [])
  assert.equal(g[0].gst, 345.10)
})
