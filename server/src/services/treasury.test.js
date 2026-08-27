import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expandRecurring, buildProjection, variableOccurrence, actionWindowStats,
  pendingWindowStart, projectAt, predictedBalanceFor,
  reconcileExpected, expectedStatus, payoutCertainty, evaluateSlackUrgency,
} from './treasury.js'

// ── expandRecurring ──────────────────────────────────────────────────────────

test('monthly : chaque mois au jour donné, borné à la fin du mois', () => {
  assert.deepEqual(
    expandRecurring({ frequency: 'monthly', day_of_month: 1 }, '2026-07-18', '2026-08-31'),
    ['2026-08-01'])
  assert.deepEqual(
    expandRecurring({ frequency: 'monthly', day_of_month: 31 }, '2026-09-01', '2026-09-30'),
    ['2026-09-30'])
})

test('biweekly : cadence 14 jours alignée sur anchor_date', () => {
  // Paie ancrée mardi 21/07 → 21/07, 04/08, 18/08 dans la fenêtre.
  assert.deepEqual(
    expandRecurring({ frequency: 'biweekly', anchor_date: '2026-07-21' }, '2026-07-18', '2026-08-20'),
    ['2026-07-21', '2026-08-04', '2026-08-18'])
  // Anchor dans le passé lointain : l'alignement reste correct.
  assert.deepEqual(
    expandRecurring({ frequency: 'biweekly', anchor_date: '2026-06-09' }, '2026-07-18', '2026-08-05'),
    ['2026-07-21', '2026-08-04'])
})

test('weekly et quarterly', () => {
  assert.deepEqual(
    expandRecurring({ frequency: 'weekly', anchor_date: '2026-07-21' }, '2026-07-20', '2026-08-04'),
    ['2026-07-21', '2026-07-28', '2026-08-04'])
  assert.deepEqual(
    expandRecurring({ frequency: 'quarterly', anchor_date: '2026-01-15' }, '2026-07-01', '2026-12-31'),
    ['2026-07-15', '2026-10-15'])
})

test('starts_on / ends_on bornent la récurrente', () => {
  const dec = { frequency: 'monthly', day_of_month: 1, starts_on: '2028-11-01', ends_on: '2034-10-01' }
  // Les versements DEC ne commencent qu'en nov. 2028 : rien à projeter avant.
  assert.deepEqual(expandRecurring(dec, '2026-08-01', '2026-12-31'), [])
  assert.deepEqual(expandRecurring(dec, '2028-10-01', '2028-12-31'), ['2028-11-01', '2028-12-01'])
  // Et plus rien après la fin de la cédule.
  assert.deepEqual(expandRecurring(dec, '2034-09-15', '2035-03-01'), ['2034-10-01'])
  // Une borne d'un seul côté fonctionne aussi.
  assert.deepEqual(
    expandRecurring({ frequency: 'monthly', day_of_month: 11, ends_on: '2031-07-11' }, '2031-06-01', '2031-12-31'),
    ['2031-06-11', '2031-07-11'])
  // biweekly : la phase reste calée sur anchor_date malgré la borne.
  assert.deepEqual(
    expandRecurring({ frequency: 'biweekly', anchor_date: '2026-07-21', starts_on: '2026-08-01' }, '2026-07-18', '2026-08-20'),
    ['2026-08-04', '2026-08-18'])
})

test('récurrence sans ancre/jour → aucune occurrence', () => {
  assert.deepEqual(expandRecurring({ frequency: 'monthly', day_of_month: null }, '2026-07-01', '2026-08-01'), [])
  assert.deepEqual(expandRecurring({ frequency: 'biweekly', anchor_date: null }, '2026-07-01', '2026-08-01'), [])
})

// ── variableOccurrence ───────────────────────────────────────────────────────
// Montant variable (relevé Mastercard) : ne s'applique qu'à la première
// occurrence suivant la saisie, puis doit être ressaisi.

test('variable : le montant saisi ne vaut que pour la prochaine occurrence', () => {
  const r = { frequency: 'monthly', day_of_month: 5, variable_amount: 1, amount: 1200 }
  // Saisi le 2 juillet → s'applique au 5 juillet (projection démarrant avant).
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-02T14:00:00.000Z' }, '2026-07-01', '2026-08-31'),
    '2026-07-05')
  // Saisi le 10 juillet (après le 5) → s'applique au 5 août.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-10T14:00:00.000Z' }, '2026-07-11', '2026-08-31'),
    '2026-08-05')
  // Saisi le jour même de l'occurrence → s'applique ce jour-là.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-05T09:00:00.000Z' }, '2026-07-05', '2026-08-31'),
    '2026-07-05')
})

test('variable : montant périmé (occurrence passée) ou jamais saisi → null', () => {
  const r = { frequency: 'monthly', day_of_month: 5, variable_amount: 1, amount: 1200 }
  // Saisi le 2 juillet pour le 5 juillet, mais on projette à partir du 6 :
  // l'occurrence est passée, le montant ne se reporte PAS au 5 août.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-02T14:00:00.000Z' }, '2026-07-06', '2026-08-31'),
    null)
  // Jamais saisi.
  assert.equal(variableOccurrence({ ...r, amount_entered_at: null }, '2026-07-01', '2026-08-31'), null)
  // Occurrence au-delà de la fenêtre de projection.
  assert.equal(
    variableOccurrence({ ...r, amount_entered_at: '2026-07-10T14:00:00.000Z' }, '2026-07-11', '2026-07-31'),
    null)
})

// ── actionWindowStats ────────────────────────────────────────────────────────
// La trésorerie est gérée au fur et à mesure : l'alerte et le virement suggéré
// ne regardent que la fenêtre d'action, pas le point bas plein horizon.

test('fenêtre d\'action : point bas et virement calculés sur les N premiers jours', () => {
  const days = [
    { date: '2026-07-21', balance: 19544 },
    { date: '2026-07-22', balance: 10670 },
    { date: '2026-07-23', balance: 2100 },   // sous le seuil, dans la fenêtre
    { date: '2026-07-24', balance: 4800 },
    { date: '2026-07-25', balance: -90000 }, // point bas lointain, HORS fenêtre
  ]
  const aw = actionWindowStats(days, 3, 5000)
  assert.equal(aw.min_balance, 2100)
  assert.equal(aw.min_date, '2026-07-23')
  // 5000 − 2100 = 2900 → arrondi au 1000 supérieur.
  assert.equal(aw.suggested_transfer, 3000)
  // Le −90 000 hors fenêtre n'influence ni le point bas ni le virement.
  const awFull = actionWindowStats(days, 10, 5000)
  assert.equal(awFull.min_balance, -90000)
  assert.equal(awFull.suggested_transfer, 95000)
})

test('fenêtre d\'action : aucun virement si le point bas reste au-dessus du seuil', () => {
  const days = [
    { date: '2026-07-21', balance: 19544 },
    { date: '2026-07-22', balance: 8000 },
  ]
  const aw = actionWindowStats(days, 14, 5000)
  assert.equal(aw.min_balance, 8000)
  assert.equal(aw.suggested_transfer, 0)
})

// ── Fenêtre « encore dû » (régression du 1er août 2026) ──────────────────────
// Le solde saisi photographie le compte à sa date de saisie. Un mouvement daté
// entre cette saisie et aujourd'hui n'est pas dedans : il reste dû. Avant ce
// correctif, l'occurrence du loyer datée du jour de la saisie disparaissait de
// la projection dès le lendemain (6 115,89 $ de trésorerie fantôme) et l'alerte
// rétrogradait en « veille ».

test('fenêtre en attente : la projection remonte jusqu\'au jour de la saisie du solde', () => {
  // Solde saisi le samedi 1er août 18 h 38 (heure locale), projection le 3.
  assert.equal(pendingWindowStart('2026-08-01T22:38:24.947Z', '2026-08-03'), '2026-08-01')
  // Saisie du jour même → aucune extension vers le passé.
  assert.equal(pendingWindowStart('2026-08-03T12:00:00.000Z', '2026-08-03'), '2026-08-03')
  // Aucune saisie → on part d'aujourd'hui.
  assert.equal(pendingWindowStart(null, '2026-08-03'), '2026-08-03')
})

test('mouvement en retard : reprojeté aujourd\'hui, jamais abandonné', () => {
  // Loyer du 1er août, projection du 3 → encore dû, marqué en retard.
  assert.deepEqual(projectAt('2026-08-01', '2026-08-03'),
    { date: '2026-08-03', late: true, original_date: '2026-08-01' })
  // Mouvement futur → inchangé, pas de marqueur.
  assert.deepEqual(projectAt('2026-08-04', '2026-08-03'), { date: '2026-08-04' })
  assert.deepEqual(projectAt('2026-08-03', '2026-08-03'), { date: '2026-08-03' })
})

test('scénario du 1er août : le loyer et la paie amènent bien le solde au négatif', () => {
  // Reconstitution : solde réel 40 435,88 $ noté le 1er août, loyer du 1er
  // (6 115,89 $) encore dû, facture en retard 3 391,76 $, paie du mardi 4
  // (25 000 $), Mastercard du 5 (1 072,86 $).
  const fromIso = '2026-08-03'
  const evts = [
    { ...projectAt('2026-08-01', fromIso), amount: -6115.89, label: 'Loyer', kind: 'recurring' },
    { ...projectAt('2026-08-01', fromIso), amount: -3391.76, label: 'Tremblay Cloutier Hamel', kind: 'bill' },
    { ...projectAt('2026-08-04', fromIso), amount: -25000, label: 'Paie', kind: 'recurring' },
    { ...projectAt('2026-08-05', fromIso), amount: -1072.86, label: 'Mastercard', kind: 'recurring' },
  ]
  const { days, min_balance } = buildProjection({
    startBalance: 40435.88, fromIso, toIso: '2026-08-06', events: evts,
  })
  // Jour 0 : les deux mouvements en retard sont absorbés aujourd'hui.
  assert.equal(days[0].balance, 30928.23)
  assert.equal(days[0].events.length, 2)
  // Le mardi 4 août reste positif de justesse, le 5 passe au rouge.
  assert.equal(days[1].balance, 5928.23)
  assert.equal(days[2].balance, 4855.37)
  assert.equal(min_balance, 4855.37)
  // Sans le report du loyer (comportement d'avant), le point bas était
  // artificiellement 6 115,89 $ plus haut — au-dessus du seuil de 5 000 $.
  const sansLoyer = buildProjection({
    startBalance: 40435.88, fromIso, toIso: '2026-08-06',
    events: evts.filter(e => e.label !== 'Loyer'),
  })
  assert.equal(Math.round((sansLoyer.min_balance - min_balance) * 100) / 100, 6115.89)
  assert.ok(min_balance < 5000 && sansLoyer.min_balance > 5000)
})

// ── Réconciliation prévu / réel ──────────────────────────────────────────────

test('solde prévu par une photo pour un jour donné', () => {
  const snap = { days: JSON.stringify([
    { date: '2026-08-02', balance: 37044.12 },
    { date: '2026-08-03', balance: 37044.12 },
    { date: '2026-08-04', balance: 12044.12 },
  ]) }
  assert.equal(predictedBalanceFor(snap, '2026-08-03'), 37044.12)
  // Hors horizon de la photo, ou photo absente / illisible → null (pas de faux
  // écart : mieux vaut ne rien réconcilier que réconcilier contre du vide).
  assert.equal(predictedBalanceFor(snap, '2026-09-01'), null)
  assert.equal(predictedBalanceFor(null, '2026-08-03'), null)
  assert.equal(predictedBalanceFor({ days: 'pas du json' }, '2026-08-03'), null)
})

// ── Couche « attendu » du passé ──────────────────────────────────────────────

const LOYER = { date: '2026-08-01', amount: -6115.89, label: 'Loyer', kind: 'recurring', ref: 'r-loyer' }

test('attendu apparié au relevé : le mouvement réel prend le libellé attendu', () => {
  const actuals = [
    { date: '2026-08-01', amount: -6115.89, label: 'PAIEMENT PREAUTORISE', kind: 'bank' },
    { date: '2026-08-01', amount: -25000, label: 'PAIE', kind: 'bank' },
  ]
  const { matched, unmatched } = reconcileExpected([LOYER], actuals, { coverageTo: '2026-08-02' })
  assert.equal(unmatched.length, 0)
  assert.deepEqual([matched[0][0].label, matched[0][1].label], ['PAIEMENT PREAUTORISE', 'Loyer'])
})

test('attendu apparié à ±3 jours et 1 % près, un réel ne sert qu\'une fois', () => {
  // Deux loyers attendus, un seul débit au relevé (daté 2 jours plus tard, à 30 $ près) :
  // le premier s'apparie, le second reste attendu.
  const actuals = [{ date: '2026-08-03', amount: -6090, label: 'PPA', kind: 'bank' }]
  const { matched, unmatched } = reconcileExpected(
    [LOYER, { ...LOYER, date: '2026-09-01' }], actuals, { coverageTo: '2026-09-30' }
  )
  assert.equal(matched.length, 1)
  assert.deepEqual(unmatched.map(e => e.date), ['2026-09-01'])
  // Hors fenêtre de date (4 j) ou hors des deux tolérances de montant (25 %
  // au second passage) → pas d'appariement.
  assert.equal(reconcileExpected([LOYER], [{ date: '2026-08-05', amount: -6115.89, kind: 'bank' }], {}).matched.length, 0)
  assert.equal(reconcileExpected([LOYER], [{ date: '2026-08-01', amount: -4000, kind: 'bank' }], {}).matched.length, 0)
  // Une sortie ne s'apparie jamais à une entrée du même montant.
  assert.equal(reconcileExpected([LOYER], [{ date: '2026-08-01', amount: 6115.89, kind: 'bank' }], {}).matched.length, 0)
})

test('appariement tolérant : montant arrondi de la récurrente, écart signalé', () => {
  // Cas réels du relevé BNC : paie 25 000 $ arrondie pour 21 542,85 $ débités,
  // dette BDC 8 874 $ pour 8 658,52 $. Appariés (et non « absents du relevé »),
  // avec l'écart exposé pour corriger le montant de la récurrente.
  const paie = { date: '2026-07-21', amount: -25000, label: 'Paie', kind: 'recurring', ref: 'r-paie' }
  const actuals = [
    { date: '2026-07-21', amount: -49.84, label: 'COMPTE DIVERS', kind: 'bank' },
    { date: '2026-07-21', amount: -21542.85, label: 'COMPTE DIVERS', kind: 'bank' },
  ]
  const { matched, unmatched } = reconcileExpected([paie], actuals, { coverageTo: '2026-07-27' })
  assert.equal(unmatched.length, 0)
  // Le candidat le plus proche en montant, pas le premier venu.
  assert.equal(matched[0][0].amount, -21542.85)
  assert.equal(matched[0][2].approx, true)
  assert.equal(matched[0][2].variance, 3457.15)
  // Au-delà de 25 % d'écart, plus d'appariement : c'est un vrai absent.
  assert.equal(reconcileExpected([paie], [{ date: '2026-07-21', amount: -15000, kind: 'bank' }], {}).unmatched.length, 1)
})

test('appariement franc prioritaire : un approximatif ne vole pas le mouvement d\'un autre', () => {
  // Deux attendus le même jour, deux débits : l'appariement exact du second ne
  // doit pas être cannibalisé par l'approximation du premier.
  const a = { date: '2026-08-10', amount: -2738, label: 'AGA', kind: 'recurring', ref: 'r-aga' }
  const b = { date: '2026-08-10', amount: -2600, label: 'Autre', kind: 'recurring', ref: 'r-b' }
  const actuals = [{ date: '2026-08-10', amount: -2600, kind: 'bank' }, { date: '2026-08-10', amount: -2738, kind: 'bank' }]
  const { matched, unmatched } = reconcileExpected([a, b], actuals, {})
  assert.equal(unmatched.length, 0)
  assert.deepEqual(matched.map(([act, exp]) => [exp.label, act.amount]), [['AGA', -2738], ['Autre', -2600]])
  assert.ok(matched.every(([, , m]) => !m.approx))
})

test('attendu non apparié : le loyer du 1er août reste visible dans le passé', () => {
  // Le cas qui a motivé la couche : relevé importé jusqu'au 27 juillet, donc le
  // loyer du 1er n'y est pas — il doit rester visible en « attendu », pas
  // disparaître comme avant.
  const { unmatched } = reconcileExpected([LOYER], [], { coverageTo: '2026-07-27' })
  assert.equal(unmatched.length, 1)
  assert.equal(unmatched[0].expected, true)
  assert.equal(unmatched[0].expected_status, 'pending_statement')
  assert.equal(unmatched[0].event_key, 'recurring:r-loyer:2026-08-01')
})

test('statut de l\'attendu : encore dû, confirmé sorti, hors couverture, absent', () => {
  // Daté à partir de la saisie du solde → déjà reprojeté aujourd'hui.
  assert.equal(expectedStatus(LOYER, { balanceDay: '2026-08-01', coverageTo: '2026-07-27' }), 'still_due')
  // Confirmé « déjà sorti » à la main → plus rien à signaler.
  assert.equal(expectedStatus(LOYER, {
    balanceDay: '2026-08-01', cleared: new Set(['recurring:r-loyer:2026-08-01']),
  }), 'cleared')
  // Antérieur à la saisie et hors couverture du relevé → normal, en attente.
  assert.equal(expectedStatus(LOYER, { balanceDay: '2026-08-03', coverageTo: '2026-07-27' }), 'pending_statement')
  // Période couverte par le relevé mais mouvement introuvable → anomalie.
  assert.equal(expectedStatus(LOYER, { balanceDay: '2026-08-03', coverageTo: '2026-08-31' }), 'missing')
})

// ── buildProjection ──────────────────────────────────────────────────────────

test('projection : solde courant, point bas et événements groupés par jour', () => {
  const { days, min_balance, min_date } = buildProjection({
    startBalance: 10000,
    fromIso: '2026-07-18',
    toIso: '2026-07-22',
    events: [
      { date: '2026-07-20', amount: -8000, label: 'Dette', kind: 'recurring' },
      { date: '2026-07-21', amount: 12000, label: 'Payout Stripe', kind: 'payout' },
      { date: '2026-07-21', amount: -25000, label: 'Paie', kind: 'recurring' },
      { date: '2026-07-30', amount: -999, label: 'hors fenêtre', kind: 'bill' },
    ],
  })
  assert.equal(days.length, 5)
  assert.equal(days[0].balance, 10000)
  assert.equal(days[2].balance, 2000)       // 20/07 : −8000
  assert.equal(days[3].balance, -11000)     // 21/07 : +12000 −25000
  assert.equal(days[3].events.length, 2)
  assert.equal(min_balance, -11000)
  assert.equal(min_date, '2026-07-21')
  // L'événement hors fenêtre est ignoré.
  assert.ok(days.every(d => d.events.every(e => e.label !== 'hors fenêtre')))
})

// ── Certitude des rentrées ───────────────────────────────────────────────────
// Un payout compté à tort gonfle le solde projeté et fait rater un découvert :
// la règle doit être stricte et surtout EXPLICITE sur ce qu'elle écarte.

test('rentrée certaine : payout en route, programmé ou déjà versé', () => {
  assert.deepEqual(payoutCertainty({ status: 'in_transit' }, {}),
    { counted: true, certainty: 'en route vers la banque' })
  assert.deepEqual(payoutCertainty({ status: 'pending' }, {}),
    { counted: true, certainty: 'programmé par Stripe' })
  assert.deepEqual(payoutCertainty({ status: 'paid' }, {}),
    { counted: true, certainty: 'versé par Stripe' })
})

test('rentrée écartée : Stripe a signalé un échec, même si le statut suit encore', () => {
  const v = payoutCertainty({ status: 'in_transit', failure_code: 'account_closed' }, {})
  assert.equal(v.counted, false)
  assert.match(v.reason, /account_closed/)
})

test('rentrée écartée : donnée Stripe périmée — un payout annulé serait encore « en route »', () => {
  const v = payoutCertainty({ status: 'in_transit' }, { stale: true, ageHours: 73, staleHours: 48 })
  assert.equal(v.counted, false)
  assert.match(v.reason, /73 h/)
  // Jamais synchronisé du tout : on ne compte pas l'argent d'une source muette.
  const never = payoutCertainty({ status: 'pending' }, { stale: true, hasSync: false })
  assert.equal(never.counted, false)
  assert.match(never.reason, /aucune synchronisation/)
})

// ── Porte Slack du canal comptabilité ────────────────────────────────────────
// Depuis le 11 août 2026, la trésorerie ne notifie plus que le découvert
// imminent : « sous le seuil de confort » et le négatif lointain restent muets.

const projFor = (balances, { threshold = 5000, actionDays = 14 } = {}) => {
  const days = balances.map((balance, i) => ({ date: `2026-08-${String(11 + i).padStart(2, '0')}`, balance }))
  const neg = days.find(d => d.balance < 0) || null
  return {
    days,
    threshold,
    action_window: actionWindowStats(days, actionDays, threshold),
    first_negative: neg && { date: neg.date, balance: neg.balance },
  }
}

test('Slack muet : point bas sous le seuil mais jamais de découvert', () => {
  const v = evaluateSlackUrgency(projFor([9000, 4000, 2500, 3000, 8000]), {})
  assert.equal(v.urgent, false)
  assert.equal(v.mode, 'negative_only')
  assert.match(v.watch, /sous le seuil .* mais jamais négatif/)
})

test('Slack parle : découvert projeté dans les 3 jours', () => {
  const v = evaluateSlackUrgency(projFor([9000, 4000, -1200, 3000]), {})
  assert.equal(v.urgent, true)
  assert.match(v.reason, /découvert/)
  assert.match(v.reason, /2026-08-13/)
})

test('Slack muet : découvert au-delà de la fenêtre de 3 jours', () => {
  // J+5 : visible sur la page Trésorerie et dans le journal, sans notification.
  const v = evaluateSlackUrgency(projFor([9000, 8000, 7000, 6000, 4000, -900]), {})
  assert.equal(v.urgent, false)
  assert.match(v.watch, /au-delà de la fenêtre de 3 j/)
  // Fenêtre élargie à 7 j → le même découvert notifie.
  const wider = evaluateSlackUrgency(projFor([9000, 8000, 7000, 6000, 4000, -900]), { slack_negative_days: '7' })
  assert.equal(wider.urgent, true)
})

test('mode historique (slack_negative_only=0) : le seuil notifie de nouveau', () => {
  const cfg = { slack_negative_only: '0', slack_urgent_days: '2' }
  const v = evaluateSlackUrgency(projFor([9000, 4000, 2500, 3000]), cfg)
  assert.equal(v.urgent, true)
  assert.equal(v.mode, 'threshold')
  // Hors fenêtre d'urgence et sans négatif : veille, comme avant.
  const far = evaluateSlackUrgency(projFor([9000, 9000, 9000, 1000, 1000]), cfg)
  assert.equal(far.urgent, false)
})
