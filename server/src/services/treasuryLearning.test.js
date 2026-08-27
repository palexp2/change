// Apprentissage de la projection sur le relevé BNC — règles pures.
//
// Les fixtures reprennent de VRAIES lignes du compte BNC CAD (libellés laconiques
// de la banque compris) : c'est là que les pièges vivent — paie qui varie de
// 21 034 à 24 763 $, loyer indexé en cours d'année, va-et-vient de la marge de
// crédit qui écraserait toute détection de cadence.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickLearnedAmount, confirmAgainstTxns, periodicClusters,
} from './treasuryLearning.js'

describe('pickLearnedAmount', () => {
  test('moins de 2 occurrences : aucune règle, la saisie reste', () => {
    assert.equal(pickLearnedAmount([]), null)
    assert.equal(pickLearnedAmount([21034.54]), null)
  })

  test('médiane des dernières occurrences (paie réelle)', () => {
    // 23 570,19 → 21 542,85 → 21 034,54 : la médiane lisse la quinzaine atypique.
    assert.equal(pickLearnedAmount([23570.19, 21542.85, 21034.54]), 21542.85)
  })

  test('jamais moins que la dernière occurrence (loyer indexé)', () => {
    // 5 863,69 · 5 863,69 · 6 115,89 : la médiane dirait encore l'ancien loyer.
    // Sous-estimer une sortie est l'erreur qui coûte un découvert.
    assert.equal(pickLearnedAmount([5863.69, 5863.69, 6115.89]), 6115.89)
  })
})

describe('pickLearnedAmount — montant variable', () => {
  test('moyenne des dernières occurrences, jamais moins que la dernière', () => {
    // Paiement du relevé Mastercard : 208,85 · 10 689,12 · 1 072,86 — la médiane
    // (1 072,86) ne prévoit rien ; la moyenne est la seule estimation utile.
    assert.equal(pickLearnedAmount([208.85, 10689.12, 1072.86], { variable: true }), 3990.28)
    // Une dernière occurrence plus élevée que la moyenne l'emporte (prudence).
    assert.equal(pickLearnedAmount([100, 200, 900], { variable: true }), 900)
  })
})

describe('confirmAgainstTxns', () => {
  const evt = (key, amount, date) => ({ event_key: key, label: key, amount, original_date: date })

  test('un débit du relevé confirme la sortie encore projetée', () => {
    const confirmed = confirmAgainstTxns(
      [evt('recurring:loyer:2026-08-01', -6115.89, '2026-08-01')],
      [{ id: 't1', date: '2026-08-03', amount: 6115.89, description: 'PMTS ENTREPRISES' }],
    )
    assert.equal(confirmed.size, 1)
    assert.equal(confirmed.get('recurring:loyer:2026-08-01').date, '2026-08-03')
    // Le montant est rendu signé (sortie) pour s'afficher comme le reste.
    assert.equal(confirmed.get('recurring:loyer:2026-08-01').amount, -6115.89)
  })

  test('montant approché toléré (paie 25 000 saisie, 21 542,85 débités)', () => {
    const confirmed = confirmAgainstTxns(
      [evt('recurring:paie:2026-07-21', -25000, '2026-07-21')],
      [{ id: 't1', date: '2026-07-21', amount: 21542.85, description: 'COMPTE DIVERS' }],
    )
    assert.equal(confirmed.size, 1)
  })

  test('un débit ne confirme qu\'une seule sortie', () => {
    const confirmed = confirmAgainstTxns(
      [evt('a', -4664.11, '2026-08-11'), evt('b', -4664.11, '2026-08-11')],
      [{ id: 't1', date: '2026-08-11', amount: 4664.11, description: 'COMPTE DIVERS' }],
    )
    assert.equal(confirmed.size, 1)
  })

  test('rien avant la date prévue, rien au-delà de la fenêtre', () => {
    // Un débit ANTÉRIEUR est un autre mouvement (l'occurrence du mois passé).
    assert.equal(confirmAgainstTxns(
      [evt('a', -2737.95, '2026-08-10')],
      [{ id: 't1', date: '2026-07-10', amount: 2737.95, description: 'ASSURANCE ENT.' }],
    ).size, 0)
    // Au-delà de 5 jours, plus rien ne garantit qu'il s'agit du même prélèvement.
    assert.equal(confirmAgainstTxns(
      [evt('a', -2737.95, '2026-08-10')],
      [{ id: 't1', date: '2026-08-20', amount: 2737.95, description: 'ASSURANCE ENT.' }],
    ).size, 0)
  })

  test('montant trop éloigné : pas de confirmation', () => {
    assert.equal(confirmAgainstTxns(
      [evt('a', -6115.89, '2026-08-01')],
      [{ id: 't1', date: '2026-08-02', amount: 503.59, description: 'PMTS ENTREPRISES' }],
    ).size, 0)
  })
})

describe('periodicClusters', () => {
  const t = (id, date, amount, description) => ({ id, date, amount, description })

  test('détecte un prélèvement mensuel et son jour', () => {
    const found = periodicClusters([
      t('1', '2026-05-11', 68.99, 'DPA ENTREPRISE'),
      t('2', '2026-06-11', 68.99, 'DPA ENTREPRISE'),
      t('3', '2026-07-13', 68.99, 'DPA ENTREPRISE'),
    ])
    assert.equal(found.length, 1)
    assert.equal(found[0].frequency, 'monthly')
    assert.equal(found[0].amount, 68.99)
    assert.equal(found[0].label, 'DPA ENTREPRISE')
    assert.equal(found[0].day_of_month, 11)
    assert.equal(found[0].monthly_cost, 68.99)
  })

  test('détecte une cadence aux deux semaines et pondère son coût mensuel', () => {
    const found = periodicClusters([
      t('1', '2026-06-10', 103.48, 'PMTS ENTREPRISES'),
      t('2', '2026-06-24', 103.48, 'PMTS ENTREPRISES'),
      t('3', '2026-07-08', 103.48, 'PMTS ENTREPRISES'),
      t('4', '2026-07-22', 103.48, 'PMTS ENTREPRISES'),
    ])
    assert.equal(found.length, 1)
    assert.equal(found[0].frequency, 'biweekly')
    assert.equal(found[0].anchor_date, '2026-07-22')
    assert.ok(found[0].monthly_cost > 103.48)
  })

  test('trois occurrences dans le même mois ne font pas une récurrence', () => {
    assert.equal(periodicClusters([
      t('1', '2026-06-02', 300, 'PMTS ENTREPRISES'),
      t('2', '2026-06-09', 300, 'PMTS ENTREPRISES'),
      t('3', '2026-06-16', 300, 'PMTS ENTREPRISES'),
    ]).length, 0)
  })

  test('montants trop dispersés : pas de groupe', () => {
    assert.equal(periodicClusters([
      t('1', '2026-05-04', 500, 'PMTS ENTREPRISES'),
      t('2', '2026-06-04', 900, 'PMTS ENTREPRISES'),
      t('3', '2026-07-04', 1400, 'PMTS ENTREPRISES'),
    ]).length, 0)
  })

  test('les centimes ne cassent pas le groupe (± 3 %)', () => {
    const found = periodicClusters([
      t('1', '2026-05-05', 1072.86, 'COMPTE A PAYER'),
      t('2', '2026-06-05', 1080.00, 'COMPTE A PAYER'),
      t('3', '2026-07-06', 1065.10, 'COMPTE A PAYER'),
    ])
    assert.equal(found.length, 1)
    assert.equal(found[0].frequency, 'monthly')
  })
})
