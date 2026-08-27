import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCarmLine, classifyPayer, matchBroker, postingSkipReason } from './carmRules.js'

const line = o => classifyCarmLine(o)

test('ventilation : « Recettes TPS sur importation » est 100 % TPS récupérable', () => {
  const r = line({ transaction_type: 'Evaluation (B3)', detail: 'Recettes TPS sur importation', party: 'AXXESS INTERNAtional', amount: 70.14 })
  assert.equal(r.kind, 'tps')
  assert.equal(r.gst_amount, 70.14)
  assert.equal(r.duty_amount, 0)
  assert.equal(r.category, 'evaluation')
})

test('ventilation : droits et surtaxes sont 100 % coût', () => {
  for (const detail of ['Droit à l\'importation', 'Surtaxes']) {
    const r = line({ transaction_type: 'Evaluation (B3)', detail, amount: 47.71 })
    assert.equal(r.duty_amount, 47.71)
    assert.equal(r.gst_amount, 0)
  }
})

test('ventilation : intérêts et pénalités sans taxe', () => {
  assert.deepEqual(
    (({ kind, duty_amount, gst_amount }) => ({ kind, duty_amount, gst_amount }))(line({ transaction_type: 'Intérêts', detail: 'Interest Receivable', amount: 1.31 })),
    { kind: 'interet', duty_amount: 0, gst_amount: 0 })
  assert.equal(line({ transaction_type: 'K23', description: 'Pénalité', amount: 100 }).kind, 'penalite')
})

test('règles fonctionnelles sans la colonne « description détaillée »', () => {
  const r = line({ transaction_type: 'TPS sur importation', party: 'United Parcells', amount: 173.28 })
  assert.equal(r.kind, 'tps')
  assert.equal(r.gst_amount, 173.28)
})

test('le dépôt de garantie est reconnu et exclu de la comptabilisation', () => {
  const r = line({ transaction_type: 'Demande dépôt de garantie', party: 'ASFC', amount: 597 })
  assert.equal(r.kind, 'garantie')
  assert.equal(postingSkipReason({ ...r }), 'garantie')
})

test('payeur : lot de cartes Orisha = nous, lot de paiements courtier = courtier', () => {
  const nous = line({ transaction_type: 'Lot de cartes', detail: 'Paiement entrant', party: 'Automatisation Orisha Inc.', amount: -500 })
  assert.equal(nous.kind, 'paiement')
  assert.equal(nous.payer, 'nous')
  const fedex = line({ transaction_type: 'Lot de paiements', detail: 'Encaissement', party: 'Federal Express Canada', amount: -30.20 })
  assert.equal(fedex.payer, 'courtier')
  assert.equal(fedex.broker, 'FedEx')
  assert.equal(postingSkipReason(fedex), 'via_courtier:FedEx')
})

test('une charge ne porte pas de payeur — le fournisseur y est le déclarant', () => {
  const r = line({ transaction_type: 'Evaluation (B3)', detail: 'Recettes TPS sur importation', party: 'Federal Express Canada', amount: 30.20 })
  assert.equal(r.payer, null)
  assert.equal(r.broker, 'FedEx')
  assert.equal(postingSkipReason(r), null)
})

test('courtiers reconnus par variante de nom', () => {
  assert.equal(matchBroker('United Parcells'), 'UPS')
  assert.equal(matchBroker('FEDERAL EXPRESS CANADA CORPORATION'), 'FedEx')
  assert.equal(matchBroker('AXXESS INTERNAtional'), 'Axxess International')
  assert.equal(matchBroker('Automatisation Orisha Inc.'), null)
  assert.equal(matchBroker('Courtier XYZ', 'Courtier XYZ'), 'Courtier XYZ')
})

test('payeur inconnu quand le relevé ne nomme personne', () => {
  assert.equal(classifyPayer({ transaction_type: 'Paiement', party: '' }).payer, 'inconnu')
})

test('un « paiement » de montant positif est requalifié (jamais un crédit)', () => {
  assert.equal(line({ transaction_type: 'Paiement', amount: 42 }).kind, 'autre')
})
