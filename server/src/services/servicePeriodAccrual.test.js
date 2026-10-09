// Facture d'un mois de service écoulé : comptabilisée à la fin de la période
// (Charles, 2026-10-03 : « septembre », datée du 1er octobre, débitée le 2).

import test from 'node:test'
import assert from 'node:assert/strict'

const { periodEndDate, serviceAccrualDate } = await import('./servicePeriod.js')

test('fin de période lue dans le libellé', () => {
  assert.equal(periodEndDate('septembre 2026'), '2026-09-30')
  assert.equal(periodEndDate('juillet–septembre 2026'), '2026-09-30')
  assert.equal(periodEndDate('15 juil. – 14 août 2026'), '2026-08-14')
  assert.equal(periodEndDate('T3 2026'), '2026-09-30')
  assert.equal(periodEndDate('année 2026'), '2026-12-31')
  assert.equal(periodEndDate('Sep 2026'), '2026-09-30')
  assert.equal(periodEndDate('février 2028'), '2028-02-29')
  assert.equal(periodEndDate('déc. 2026 – janv. 2027'), '2027-01-31')
  assert.equal(periodEndDate('septembre', '2026-10-01'), '2026-09-30')
  assert.equal(periodEndDate(''), null)
  assert.equal(periodEndDate('abonnement mensuel'), null)
})

test('date de comptabilisation au mois du service', () => {
  assert.equal(serviceAccrualDate('septembre 2026', '2026-10-02'), '2026-09-30')
  assert.equal(serviceAccrualDate('15 juil. – 14 août 2026', '2026-09-03'), '2026-08-14')
  // Même mois, ou période à venir : la date habituelle tient.
  assert.equal(serviceAccrualDate('octobre 2026', '2026-10-02'), null)
  assert.equal(serviceAccrualDate('année 2026', '2026-01-05'), null)
  assert.equal(serviceAccrualDate('novembre 2026', '2026-10-28'), null)
  // Plus de 3 mois en arrière : rattrapage, pas une facture du mois passé.
  assert.equal(serviceAccrualDate('mai 2026', '2026-10-02'), null)
  assert.equal(serviceAccrualDate('juillet 2026', '2026-10-02'), '2026-07-31')
  assert.equal(serviceAccrualDate(null, '2026-10-02'), null)
})
