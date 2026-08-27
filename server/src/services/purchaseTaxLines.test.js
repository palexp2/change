// Override TaxLine[] d'un achat QB (Purchase/Bill) : les montants de TPS/TVQ extraits
// de la facture sont publiés tels quels au lieu d'être recalculés par QB.
//
// Régression (facture livre Amazon.ca du 2026-08-02, 21,99 $ + 1,10 $ de TPS) : le
// code de taxe pré-rempli était le groupé « TPS/TVQ QC - 9,975 » alors que la facture
// ne porte que la TPS (TVH ON remise sur les livres). L'override n'émettait alors que
// le TaxRate de TPS et omettait celui de TVQ → QB refusait la création en 6000
// « QuickBooks a rencontré une erreur lors du calcul de la taxe ». Vérifié contre la
// QB de prod le 2026-08-05 : le même payload avec le TaxRate de TVQ émis à 0 $ passe.

import test from 'node:test'
import assert from 'node:assert/strict'

const { buildTaxLinesFromRates } = await import('./quickbooks.js')

const TPS = { id: '7', percent: 5 }              // TPS (CTI)
const TVQ = { id: '22', percent: 9.975 }         // TVQ 9,975 (RTI)
const TVH_ON = { id: '30', percent: 13 }         // TVH ON — code à taux unique
// « TPS/TVQ repas » : taux d'achat réduits (récupération 50 %) — non classables.
const TPS_REPAS = { id: '33', percent: 2.3259 }
const TVQ_REPAS = { id: '34', percent: 4.64007 }

const byRate = lines => new Map(lines.map(l => [l.TaxLineDetail.TaxRateRef.value, l]))

test('code groupé, une seule composante facturée → le taux à 0 $ est émis quand même', () => {
  const lines = buildTaxLinesFromRates([TPS, TVQ], { tpsAmt: 1.1, tvqAmt: 0, subtotalAmt: 21.99 })
  assert.equal(lines.length, 2, 'les DEUX taux du code groupé doivent figurer (sinon QB 6000)')
  const m = byRate(lines)
  assert.equal(m.get('7').Amount, 1.1)
  assert.equal(m.get('7').TaxLineDetail.NetAmountTaxable, 21.99)
  assert.equal(m.get('22').Amount, 0)
  // Un taux à 0 $ n'a rien taxé : base taxable à 0 (QB rejette base > 0 sans taxe).
  assert.equal(m.get('22').TaxLineDetail.NetAmountTaxable, 0)
  assert.equal(m.get('22').TaxLineDetail.TaxPercent, 9.975)
  assert.ok(lines.every(l => l.DetailType === 'TaxLineDetail' && l.TaxLineDetail.PercentBased === true))
})

test('code groupé, TPS + TVQ facturées → ventilation par taux (cas nominal)', () => {
  const lines = buildTaxLinesFromRates([TPS, TVQ], { tpsAmt: 3.03, tvqAmt: 6.05, subtotalAmt: 60.6 })
  const m = byRate(lines)
  assert.equal(m.get('7').Amount, 3.03)
  assert.equal(m.get('22').Amount, 6.05)
  assert.equal(m.get('7').TaxLineDetail.NetAmountTaxable, 60.6)
  assert.equal(m.get('22').TaxLineDetail.NetAmountTaxable, 60.6)
})

test('code groupé, TVQ seule facturée → le taux de TPS est émis à 0 $', () => {
  const lines = buildTaxLinesFromRates([TPS, TVQ], { tpsAmt: 0, tvqAmt: 9.98, subtotalAmt: 100 })
  const m = byRate(lines)
  assert.equal(m.get('7').Amount, 0)
  assert.equal(m.get('22').Amount, 9.98)
})

test('code à taux unique → tout le montant de taxe (TPS + TVQ + autres) sur ce taux', () => {
  // other_taxes porte la TVH d'une autre province (cf. extraction multi-régions).
  const lines = buildTaxLinesFromRates([TVH_ON], { tpsAmt: 0, tvqAmt: 0, otherAmt: 13, subtotalAmt: 100 })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Amount, 13)
  assert.equal(lines[0].TaxLineDetail.NetAmountTaxable, 100)
})

test('aucune taxe à ventiler → null (auto-calc QB, pas d’override à 0)', () => {
  assert.equal(buildTaxLinesFromRates([TPS, TVQ], { subtotalAmt: 50 }), null)
  assert.equal(buildTaxLinesFromRates([TVH_ON], { subtotalAmt: 50 }), null)
})

test('code à taux non classables (TPS/TVQ repas) → null plutôt qu’un override faux', () => {
  // 2,3259 % / 4,64007 % = récupération réduite : publier les montants pleins de la
  // facture sur ces taux gonflerait le CTI/RTI réclamé. On laisse QB calculer.
  assert.equal(buildTaxLinesFromRates([TPS_REPAS, TVQ_REPAS], { tpsAmt: 5, tvqAmt: 9.98, subtotalAmt: 100 }), null)
})

test('code sans taux d’achat (0 % : Détaxé/Exonéré/Hors champ) → null', () => {
  assert.equal(buildTaxLinesFromRates([], { tpsAmt: 1.1, subtotalAmt: 21.99 }), null)
  assert.equal(buildTaxLinesFromRates(null, { tpsAmt: 1.1, subtotalAmt: 21.99 }), null)
})
