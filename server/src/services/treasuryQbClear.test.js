import test from 'node:test'
import assert from 'node:assert/strict'
import { matchConfidence, matchPaymentsToLedger, matchBillsToLedger } from './treasuryQbClear.js'

// Écritures réelles du grand livre QB du compte BNC CAD (août 2026), déjà
// filtrées sur « compensée » (C) / « rapprochée » (R). amount signé : négatif =
// sortie d'argent.
const NOVO = { date: '2026-08-07', amount: -352.48, name: 'Novo Express', type: 'Paiement de factures (chèque)', entity: 'billpayment', qbId: '9001', cleared: 'C' }
const DUBOIS = { date: '2026-08-09', amount: -830.77, name: 'Dubois Agrinovation', type: 'Paiement de factures (chèque)', entity: 'billpayment', qbId: '9002', cleared: 'C' }
const VIR_OUT = { date: '2026-08-10', amount: -20000, name: null, type: 'Virement', entity: 'transfer', qbId: '9003', cleared: 'C' }
const VIR_IN = { date: '2026-08-04', amount: 10000, name: null, type: 'Virement', entity: 'transfer', qbId: '9004', cleared: 'C' }
const BTTH = { date: '2026-07-23', amount: -103.48, name: 'BTTH SERVICES MUTIPLES', type: 'Paiement de factures (chèque)', entity: 'billpayment', qbId: '9005', cleared: 'R' }

const pmt = (o) => ({ id: o.id, payment_date: o.date, direction: o.direction || 'out', amount: o.amount, label: o.label || null, recipient: o.recipient || null })

test('nom concordant + montant + date → appariement sûr', () => {
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-07', amount: 352.48, label: 'Novo Express' }), NOVO), 'high')
  // Écart de date toléré (Interac du samedi débité le lundi).
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-05', amount: 352.48, label: 'Novo Express' }), NOVO), 'high')
  // Raison sociale divergente sur le suffixe légal : premier mot significatif commun.
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-07-23', amount: 103.48, label: 'BTTH Services multiples inc.' }), BTTH), 'high')
  // Bénéficiaire réel plutôt que fournisseur (virement Interac).
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-09', amount: 830.77, label: 'Facture août', recipient: 'Dubois Agrinovation' }), DUBOIS), 'high')
})

test('montant identique mais AUTRE fournisseur → à confirmer, jamais appliqué seul', () => {
  // Le piège réel : BTTH SERVICES MUTIPLES et Axxess International facturent
  // tous deux 103,48 $. Cocher sur le montant seul cocherait la mauvaise ligne.
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-07-23', amount: 103.48, label: 'Axxess International – CAD' }), BTTH), 'low')
})

test('virement interne (QB ne nomme pas) : montant au cent près et ≤ 2 jours', () => {
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-10', amount: 20000, label: 'BNC CAD → BNC Épargne' }), VIR_OUT), 'high')
  assert.equal(matchConfidence(pmt({ id: 'p2', date: '2026-08-04', amount: 10000, direction: 'in', label: 'Venn CAD → BNC CAD' }), VIR_IN), 'high')
  // Trop loin dans le temps : plausible mais pas sûr → à confirmer.
  assert.equal(matchConfidence(pmt({ id: 'p3', date: '2026-08-06', amount: 20000, label: 'BNC CAD → BNC Épargne' }), VIR_OUT), 'low')
  // Montant seulement voisin (tolérance 1 %) sans nom : pas de certitude.
  assert.equal(matchConfidence(pmt({ id: 'p4', date: '2026-08-10', amount: 19900, label: 'Virement' }), VIR_OUT), 'low')
})

test('sens, montant hors tolérance et date hors fenêtre → aucun appariement', () => {
  // Une entrée d'argent ne peut pas correspondre à une sortie QB.
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-07', amount: 352.48, direction: 'in', label: 'Novo Express' }), NOVO), null)
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-07', amount: 500, label: 'Novo Express' }), NOVO), null)
  assert.equal(matchConfidence(pmt({ id: 'p1', date: '2026-08-20', amount: 352.48, label: 'Novo Express' }), NOVO), null)
})

test('une écriture QB ne coche qu\'un paiement, le meilleur candidat gagne', () => {
  // Deux paiements Novo Express au même montant : l'écriture QB du 7 août va au
  // paiement daté du 7, pas à celui du 4.
  const matches = matchPaymentsToLedger([
    pmt({ id: 'loin', date: '2026-08-04', amount: 352.48, label: 'Novo Express' }),
    pmt({ id: 'proche', date: '2026-08-07', amount: 352.48, label: 'Novo Express' }),
  ], [NOVO])
  assert.equal(matches.length, 1)
  assert.equal(matches[0].payment.id, 'proche')
})

test('l\'appariement sûr est servi avant le douteux sur la même écriture', () => {
  const matches = matchPaymentsToLedger([
    pmt({ id: 'homonyme', date: '2026-07-23', amount: 103.48, label: 'Axxess International – CAD' }),
    pmt({ id: 'vrai', date: '2026-07-23', amount: 103.48, label: 'BTTH Services multiples' }),
  ], [BTTH])
  assert.equal(matches.length, 1)
  assert.equal(matches[0].payment.id, 'vrai')
  assert.equal(matches[0].confidence, 'high')
})

test('factures à payer : nom obligatoire, jamais sur le montant seul', () => {
  const bills = [
    { id: 'b1', vendor: 'Novo Express', due_date: '2026-08-14', total_cad: 352.48, balance_due_cad: 352.48 },
    // Même montant, autre fournisseur : ne doit PAS être proposée sur l'écriture Novo.
    { id: 'b2', vendor: 'Fabrique Manic', due_date: '2026-08-14', total_cad: 352.48, balance_due_cad: 352.48 },
    // Bon fournisseur mais échéance très éloignée de l'écriture.
    { id: 'b3', vendor: 'Dubois Agrinovation', due_date: '2026-11-30', total_cad: 830.77, balance_due_cad: 830.77 },
  ]
  const matches = matchBillsToLedger(bills, [NOVO, DUBOIS])
  assert.deepEqual(matches.map(m => m.bill.id), ['b1'])
  // Une facture détectée reste « à confirmer » : créer un paiement est une
  // écriture de plus, l'utilisateur tranche.
  assert.equal(matches[0].confidence, 'low')
})

test('factures à payer : un encaissement QB ne règle pas une facture', () => {
  const bills = [{ id: 'b1', vendor: 'Novo Express', due_date: '2026-08-04', total_cad: 10000, balance_due_cad: 10000 }]
  assert.deepEqual(matchBillsToLedger(bills, [{ ...VIR_IN, name: 'Novo Express' }]), [])
})
