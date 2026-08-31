// Suivi de plafond des cartes — le calcul du paiement recommandé et
// l'anti-doublon d'alerte.
//
// Ces deux-là sont testés parce qu'ils décident seuls : le premier dicte le
// montant qu'un humain va réellement payer, le second décide si le canal
// comptabilité reçoit un message ou pas. Tous deux sont purs, aucune DB ici.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCardCeiling, decideCardAlert, nextDraftDate } from './cardCeiling.js'

// ── Prochaine date de prélèvement ────────────────────────────────────────────

test('le prélèvement du mois si on n\'y est pas encore passé, sinon celui du mois suivant', () => {
  assert.equal(nextDraftDate('2026-09-01', 4), '2026-09-04')
  assert.equal(nextDraftDate('2026-09-04', 4), '2026-09-04')  // le jour même compte
  assert.equal(nextDraftDate('2026-09-05', 4), '2026-10-04')
  // Un jour qui n'existe pas dans le mois est borné à la fin du mois : sans ça
  // « le 31 » sauterait février au complet.
  assert.equal(nextDraftDate('2027-02-01', 31), '2027-02-28')
})

// ── Paiement recommandé ──────────────────────────────────────────────────────
// Règle : assez pour repasser SOUS le plafond, arrondi au dollar SUPÉRIEUR.

test('le montant recommandé ramène le solde projeté sous le plafond, arrondi au dollar supérieur', () => {
  // 9 100 comptabilisé + 5 153,40 en attente = 14 253,40 projeté, plafond 10 000
  const o = computeCardCeiling({
    posted: 9100, pending: 5153.40, ceiling: 10000, credit_limit: 15000,
    draft_day: 4, today: '2026-08-30',
  })
  assert.equal(o.projected, 14253.40)
  // 4 253,40 → 4 254 : arrondir vers le bas laisserait la carte collée au plafond.
  assert.equal(o.recommended, 4254)
  assert.equal(o.over_ceiling, true)
  assert.equal(o.over_limit, false)
  // Marge NÉGATIVE quand le plafond est franchi — c'est le dépassement.
  assert.equal(o.room, -4253.40)
  assert.equal(o.room_to_limit, 746.60)
  // Payer le montant recommandé repasse bien sous le plafond.
  assert.ok(o.projected - o.recommended < o.ceiling)
})

test('sous le plafond : aucun paiement recommandé, la marge reste positive', () => {
  const o = computeCardCeiling({
    posted: 3663.20, pending: 812.55, ceiling: 10000, credit_limit: 15000,
    draft_day: 4, today: '2026-08-30',
  })
  assert.equal(o.projected, 4475.75)
  assert.equal(o.recommended, 0)
  assert.equal(o.over_ceiling, false)
  assert.equal(o.room, 5524.25)
})

test('les transactions en attente comptent — sans elles on sous-estime le solde', () => {
  const sansAttente = computeCardCeiling({ posted: 9800, pending: 0, ceiling: 10000, today: '2026-08-30' })
  const avecAttente = computeCardCeiling({ posted: 9800, pending: 900, ceiling: 10000, today: '2026-08-30' })
  assert.equal(sansAttente.recommended, 0)      // en apparence, tout va bien
  assert.equal(avecAttente.recommended, 700)    // en réalité, 700 $ à payer
  // Les deux chiffres restent séparés : ils ne se vérifient pas de la même façon.
  assert.equal(avecAttente.posted, 9800)
  assert.equal(avecAttente.pending, 900)
})

test('pile sur le plafond, on ne recommande rien (le plafond est un maximum admis)', () => {
  const o = computeCardCeiling({ posted: 10000, pending: 0, ceiling: 10000, today: '2026-08-30' })
  assert.equal(o.recommended, 0)
  assert.equal(o.over_ceiling, false)
  assert.equal(o.room, 0)
  // Un cent de plus bascule, et le recommandé est d'un dollar (arrondi sup.).
  assert.equal(computeCardCeiling({ posted: 10000.01, ceiling: 10000, today: '2026-08-30' }).recommended, 1)
})

test('sans plafond configuré, rien n\'est recommandé et la marge est inconnue', () => {
  const o = computeCardCeiling({ posted: 12000, pending: 500, ceiling: 0, credit_limit: 0, today: '2026-08-30' })
  assert.equal(o.recommended, 0)
  assert.equal(o.room, null)
  assert.equal(o.ceiling, null)
})

test('la date de paiement recule au jour ouvrable précédent quand le prélèvement tombe mal', () => {
  // 4 octobre 2026 = dimanche → on paie le vendredi 2.
  const o = computeCardCeiling({ posted: 12000, ceiling: 10000, draft_day: 4, today: '2026-09-20' })
  assert.equal(o.draft_date, '2026-10-04')
  assert.equal(o.pay_date, '2026-10-02')
  assert.equal(o.pay_reason, 'weekend')
  assert.equal(o.days_to_draft, 14)
})

// ── Anti-doublon d'alerte ────────────────────────────────────────────────────
// Une alerte par carte, par mois et par type. Les deux types ne s'excluent pas :
// une carte qui a déjà crié « plafond franchi » le 20 doit quand même recevoir
// son rappel J-5 avec le montant à payer.

const enFenetre = computeCardCeiling({ posted: 11000, ceiling: 10000, draft_day: 4, today: '2026-09-01' })   // J-3
const horsFenetre = computeCardCeiling({ posted: 11000, ceiling: 10000, draft_day: 4, today: '2026-09-10' }) // J-25
const sousPlafond = computeCardCeiling({ posted: 8000, ceiling: 10000, draft_day: 4, today: '2026-09-01' })

test('dans la fenêtre du prélèvement, l\'alerte est de type « lead »', () => {
  assert.equal(enFenetre.days_to_draft, 3)
  assert.deepEqual(decideCardAlert(enFenetre, { leadDays: 5 }), { kind: 'lead' })
})

test('hors fenêtre, un franchissement du plafond alerte immédiatement (« breach »)', () => {
  assert.equal(horsFenetre.days_to_draft, 24)
  assert.deepEqual(decideCardAlert(horsFenetre, { leadDays: 5 }), { kind: 'breach' })
})

test('une alerte déjà envoyée ce mois-ci pour ce type ne repart pas', () => {
  assert.equal(decideCardAlert(enFenetre, { leadDays: 5, sentKinds: ['lead'] }), null)
  assert.equal(decideCardAlert(horsFenetre, { leadDays: 5, sentKinds: ['breach'] }), null)
})

test('les deux types sont indépendants : un « breach » envoyé n\'avale pas le rappel J-5', () => {
  assert.deepEqual(decideCardAlert(enFenetre, { leadDays: 5, sentKinds: ['breach'] }), { kind: 'lead' })
  assert.deepEqual(decideCardAlert(horsFenetre, { leadDays: 5, sentKinds: ['lead'] }), { kind: 'breach' })
  // Les deux consommés : plus rien ce mois-ci.
  assert.equal(decideCardAlert(enFenetre, { leadDays: 5, sentKinds: ['lead', 'breach'] }), null)
})

test('sous le plafond, la fenêtre J-5 reste muette — sauf si on demande le rappel systématique', () => {
  assert.equal(decideCardAlert(sousPlafond, { leadDays: 5 }), null)
  assert.deepEqual(decideCardAlert(sousPlafond, { leadDays: 5, leadAlways: true }), { kind: 'lead' })
  // Même en rappel systématique, l'anti-doublon tient.
  assert.equal(decideCardAlert(sousPlafond, { leadDays: 5, leadAlways: true, sentKinds: ['lead'] }), null)
})

test('un dépassement sous le seuil de matérialité n\'alerte pas', () => {
  const petit = computeCardCeiling({ posted: 10030, ceiling: 10000, draft_day: 4, today: '2026-09-10' })
  assert.equal(decideCardAlert(petit, { leadDays: 5, minAmount: 100 }), null)
  assert.deepEqual(decideCardAlert(petit, { leadDays: 5, minAmount: 0 }), { kind: 'breach' })
})

test('sous le plafond et hors fenêtre : rien, jamais', () => {
  const calme = computeCardCeiling({ posted: 4000, ceiling: 10000, draft_day: 4, today: '2026-09-10' })
  assert.equal(decideCardAlert(calme, { leadDays: 5 }), null)
  assert.equal(decideCardAlert(calme, { leadDays: 5, leadAlways: true }), null)
})
