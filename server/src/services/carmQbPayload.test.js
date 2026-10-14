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

test('lot : charges et corrections nettées en une facture, versement = paiement de facture + trop-versé', async () => {
  const { mergeGroupsForPosting, buildBillPayload, buildPaymentPlan } = await import('./carmQb.js')
  const L = (id, d, amt, kind, extra = {}) => ({ id, transaction_date: d, transaction_number: id, amount: amt, kind,
    posting_state: 'a_comptabiliser', duty_amount: null, gst_amount: kind === 'tps' ? Math.abs(amt) : null, ...extra })
  const groups = mergeGroupsForPosting(buildPostingGroups([
    L('b', '2026-07-09', 345.10, 'tps'), L('c', '2026-07-09', -79.46, 'tps', { kind: 'tps' }),
    L('i', '2026-07-31', 1.44, 'interet'),
    L('p', '2026-08-03', -500, 'paiement', { payer: 'nous' }),
  ], { tolerance: 0.02 }))
  const bill = groups[0]
  assert.equal(bill.type, 'charge')
  assert.equal(bill.gst, 265.64)
  assert.equal(bill.total, 267.08)
  const ids = { vendor: '1013', duty: '65', interest: '79', penalty: '70', tps: '5', noTax: '2', tpsRate: '7' }
  const p = buildBillPayload(bill, ids)
  assert.equal(p.entity, 'bill')
  assert.equal(p.body.TxnTaxDetail.TotalTax, 265.64)
  assert.match(p.body.PrivateNote, /du 09\/07\/2026 au 31\/07\/2026/)
  const plan = buildPaymentPlan(groups[1], [{ id: '18031', date: '2026-08-01', balance: 267.08 }],
    { id: '22', isCard: true, vendor: '1013', ap: '21', noTax: '2' })
  assert.deepEqual(plan.map(d => d.entity), ['billpayment', 'purchase'])
  assert.equal(plan[0].body.TotalAmt, 267.08)
  assert.equal(plan[1].body.Line[0].Amount, 232.92)
})

test('déjà saisi à la main : facture couvrant la période et versement 267,12 + 232,88 reconnus', async () => {
  const { matchExistingQb } = await import('./carmQb.js')
  const lines = [
    { id: 'b3', transaction_date: '2026-07-09', amount: 267.12, kind: 'tps', posting_state: 'a_comptabiliser' },
    { id: 'in', transaction_date: '2026-08-31', amount: 0.18, kind: 'interet', posting_state: 'a_comptabiliser' },
    { id: 'p1', transaction_date: '2026-08-03', transaction_number: '401810235', amount: -297.32, kind: 'paiement', payer: 'nous', posting_state: 'a_comptabiliser' },
    { id: 'p2', transaction_date: '2026-08-03', transaction_number: '401810235', amount: -202.68, kind: 'paiement', payer: 'nous', posting_state: 'a_comptabiliser' },
  ]
  const docs = [
    { entity: 'bill', id: '18031', date: '2026-08-01', total: 267.12, note: "Pour ctb les transactions non réglées à l'ASFC (du 01/05/2026 au 31/07/2026)" },
    { entity: 'billpayment', id: '18033', date: '2026-08-03', total: 267.12 },
    { entity: 'purchase', id: '18032', date: '2026-08-03', total: 232.88 },
  ]
  const links = matchExistingQb(lines, docs)
  assert.equal(links.get('b3')[0].id, '18031')
  assert.equal(links.has('in'), false)
  assert.deepEqual(links.get('p1').map(d => d.id).sort(), ['18032', '18033'])
})
