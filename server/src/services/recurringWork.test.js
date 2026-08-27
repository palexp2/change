import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  periodKeyFor, periodLabel, isoWeek, weekStart, weekKeyToDay, describeWeek, weekOptions,
  periodRange, previousPeriodKey, periodDueDate, dueInfo, catchUpPeriods, isValidPeriodKey,
  slotFromKey, biweeklyOccurrences,
} from './recurringWork.js'

// ── Clés de période ───────────────────────────────────────────────────────────
// C'est l'unité de cochage : une clé fausse cocherait la mauvaise semaine (ou
// rouvrirait une case déjà faite), donc chaque cadence est vérifiée aux bornes.

test('hebdo : semaine ISO, lundi = premier jour', () => {
  // Lundi 3 août 2026 et dimanche 9 août 2026 → même semaine ISO.
  assert.equal(periodKeyFor('hebdo', '2026-08-03'), '2026-W32')
  assert.equal(periodKeyFor('hebdo', '2026-08-09'), '2026-W32')
  // Le lundi suivant bascule.
  assert.equal(periodKeyFor('hebdo', '2026-08-10'), '2026-W33')
})

test('hebdo : passage d\'année ISO', () => {
  // 1er janvier 2027 est un vendredi → semaine 53 de 2026 (règle ISO).
  assert.equal(periodKeyFor('hebdo', '2027-01-01'), '2026-W53')
  // 4 janvier 2027 (lundi) ouvre la semaine 1 de 2027.
  assert.equal(periodKeyFor('hebdo', '2027-01-04'), '2027-W01')
})

test('isoWeek : semaine 1 contient toujours le 4 janvier', () => {
  assert.deepEqual(isoWeek('2026-01-04'), { year: 2026, week: 1 })
  assert.deepEqual(isoWeek('2026-12-31'), { year: 2026, week: 53 })
})

test('mensuel / trimestriel / annuel', () => {
  assert.equal(periodKeyFor('mensuel', '2026-08-04'), '2026-08')
  assert.equal(periodKeyFor('mensuel', '2026-12-31'), '2026-12')
  assert.equal(periodKeyFor('trimestriel', '2026-08-04'), '2026-Q3')
  assert.equal(periodKeyFor('trimestriel', '2026-09-30'), '2026-Q3')
  assert.equal(periodKeyFor('trimestriel', '2026-10-01'), '2026-Q4')
  assert.equal(periodKeyFor('annuel', '2026-08-04'), '2026')
})

test('adhoc : clé unique — une fois cochée, jamais réouverte', () => {
  assert.equal(periodKeyFor('adhoc', '2026-08-04'), 'adhoc')
  assert.equal(periodKeyFor('adhoc', '2027-03-01'), 'adhoc')
})

test('libellés de période', () => {
  assert.equal(periodLabel('hebdo', '2026-08-04'), 'semaine 32')
  assert.equal(periodLabel('mensuel', '2026-08-04'), 'août 2026')
  assert.equal(periodLabel('trimestriel', '2026-08-04'), 'T3 2026')
  assert.equal(periodLabel('annuel', '2026-08-04'), '2026')
  assert.equal(periodLabel('adhoc', '2026-08-04'), 'à faire une fois')
})

// ── Navigation par semaine ────────────────────────────────────────────────────
// L'ancre de lecture est un lundi : une clé qui ne retombe pas sur le bon lundi
// ferait cocher la mauvaise semaine, donc l'aller-retour clé ↔ jour est vérifié.

test('weekStart : n\'importe quel jour → le lundi de sa semaine', () => {
  assert.equal(weekStart('2026-08-09'), '2026-08-03') // dimanche → lundi précédent
  assert.equal(weekStart('2026-08-03'), '2026-08-03') // lundi → lui-même
  assert.equal(weekStart('2026-08-10'), '2026-08-10')
})

test('weekKeyToDay : aller-retour avec periodKeyFor', () => {
  assert.equal(weekKeyToDay('2026-W32'), '2026-08-03')
  assert.equal(weekKeyToDay('2026-W33'), '2026-08-10')
  assert.equal(weekKeyToDay('2027-W01'), '2027-01-04')
  // Semaine 53 réelle (2026 en compte 53) vs semaine 53 inexistante (2027).
  assert.equal(weekKeyToDay('2026-W53'), '2026-12-28')
  assert.equal(weekKeyToDay('2027-W53'), null)
  assert.equal(weekKeyToDay('n\'importe quoi'), null)
  assert.equal(weekKeyToDay(''), null)
})

test('describeWeek : bornes lundi→dimanche et semaine courante', () => {
  const w = describeWeek('2026-08-05', '2026-08-09')
  assert.equal(w.key, '2026-W32')
  assert.equal(w.start, '2026-08-03')
  assert.equal(w.end, '2026-08-09')
  assert.equal(w.is_current, true, 'le 9 août tombe dans la semaine 32')
  assert.equal(describeWeek('2026-08-12', '2026-08-09').is_current, false)
  assert.match(w.label, /^Semaine 32 · 3 août au 9 août 2026$/)
})

test('weekOptions : fenêtre autour de la semaine courante, ancienne semaine incluse à la demande', () => {
  const opts = weekOptions({ back: 2, forward: 1, date: '2026-08-09' })
  assert.deepEqual(opts.map(w => w.key), ['2026-W30', '2026-W31', '2026-W32', '2026-W33'])
  assert.equal(opts.filter(w => w.is_current).length, 1)

  const withOld = weekOptions({ back: 2, forward: 1, date: '2026-08-09', include: '2026-W10' })
  assert.equal(withOld[0].key, '2026-W10', 'la semaine demandée hors fenêtre reste sélectionnable')
  const unknown = weekOptions({ back: 1, forward: 0, date: '2026-08-09', include: 'bidon' })
  assert.deepEqual(unknown.map(w => w.key), ['2026-W31', '2026-W32'])
})

// ── Échéance dans la période ──────────────────────────────────────────────────
// « Payer Visa » est dû le 25 : le statut doit basculer AVANT le 25, et le
// dépassement doit rester visible tant que la case n'est pas cochée.

test('periodRange : bornes de chaque cadence', () => {
  assert.deepEqual(periodRange('mensuel', '2026-08'), { start: '2026-08-01', end: '2026-08-31' })
  assert.deepEqual(periodRange('mensuel', '2026-02'), { start: '2026-02-01', end: '2026-02-28' })
  assert.deepEqual(periodRange('mensuel', '2028-02'), { start: '2028-02-01', end: '2028-02-29' }, 'année bissextile')
  assert.deepEqual(periodRange('trimestriel', '2026-Q3'), { start: '2026-07-01', end: '2026-09-30' })
  assert.deepEqual(periodRange('annuel', '2026'), { start: '2026-01-01', end: '2026-12-31' })
  assert.deepEqual(periodRange('hebdo', '2026-W32'), { start: '2026-08-03', end: '2026-08-09' })
  assert.equal(periodRange('adhoc', 'adhoc'), null)
  assert.equal(periodRange('mensuel', '2026-13'), null)
})

test('previousPeriodKey : recule d\'une période, y compris au changement d\'année', () => {
  assert.equal(previousPeriodKey('mensuel', '2026-08'), '2026-07')
  assert.equal(previousPeriodKey('mensuel', '2026-01'), '2025-12')
  assert.equal(previousPeriodKey('trimestriel', '2026-Q1'), '2025-Q4')
  assert.equal(previousPeriodKey('annuel', '2026'), '2025')
  assert.equal(previousPeriodKey('hebdo', '2026-W32'), '2026-W31')
  assert.equal(previousPeriodKey('adhoc', 'adhoc'), null)
})

test('periodDueDate : jour du mois, ramené au dernier jour quand il déborde', () => {
  assert.equal(periodDueDate('mensuel', '2026-08', 25), '2026-08-25')
  assert.equal(periodDueDate('mensuel', '2026-02', 31), '2026-02-28', 'le 31 février = le 28')
  assert.equal(periodDueDate('mensuel', '2026-08', null), null)
  assert.equal(periodDueDate('hebdo', '2026-W32', 25), null, 'pas d\'échéance en jour du mois pour l\'hebdo')
})

test('dueInfo : à venir → bientôt → en retard, et rien une fois coché', () => {
  const at = (today, done = false) => dueInfo({ cadence: 'mensuel', periodKey: '2026-08', dueDay: 25, done, today })
  assert.equal(at('2026-08-01').due_status, 'upcoming')
  assert.equal(at('2026-08-20').due_status, 'due_soon', '5 jours avant, la ligne doit crier')
  assert.equal(at('2026-08-25').due_status, 'due_soon')
  assert.equal(at('2026-08-25').days_until_due, 0)
  assert.equal(at('2026-08-26').due_status, 'overdue')
  assert.equal(at('2026-08-26').days_until_due, -1)
  assert.equal(at('2026-08-26', true).due_status, null, 'cochée = plus aucune alerte')
  assert.equal(dueInfo({ cadence: 'mensuel', periodKey: '2026-08', dueDay: null, done: false, today: '2026-08-26' }).due_status, null)
})

// ── Rattrapage de la période précédente ───────────────────────────────────────
// Le cas de l'utilisateur : la tâche mensuelle de juillet se fait début août.
// Cocher doit marquer JUILLET, donc juillet doit rester proposé, nommément.

test('catchUpPeriods : un mois terminé non coché reste proposé', () => {
  const out = catchUpPeriods({
    cadence: 'mensuel', periodKey: '2026-08', today: '2026-08-03',
    createdDay: '2026-01-01', dueDay: 25, isDone: () => false,
  })
  assert.deepEqual(out.map(p => p.period_key), ['2026-07', '2026-06', '2026-05'])
  assert.equal(out[0].period_label, 'juillet 2026')
  assert.equal(out[0].due_date, '2026-07-25')
})

test('catchUpPeriods : le mois coché disparaît du rattrapage', () => {
  const out = catchUpPeriods({
    cadence: 'mensuel', periodKey: '2026-08', today: '2026-08-03',
    createdDay: '2026-01-01', isDone: k => k === '2026-07',
  })
  assert.deepEqual(out.map(p => p.period_key), ['2026-06', '2026-05'])
})

test('catchUpPeriods : jamais de retard avant la création du travail', () => {
  const out = catchUpPeriods({
    cadence: 'mensuel', periodKey: '2026-08', today: '2026-08-12',
    createdDay: '2026-08-04', isDone: () => false,
  })
  assert.deepEqual(out, [], 'un travail créé en août ne doit pas naître en retard de juillet')
})

test('catchUpPeriods : ni période en cours, ni cadences courtes', () => {
  // La période affichée elle-même n'est jamais un « retard ».
  const mensuel = catchUpPeriods({
    cadence: 'mensuel', periodKey: '2026-08', today: '2026-08-12',
    createdDay: '2020-01-01', isDone: () => false, depth: 1,
  })
  assert.deepEqual(mensuel.map(p => p.period_key), ['2026-07'])
  assert.deepEqual(catchUpPeriods({ cadence: 'hebdo', periodKey: '2026-W32', today: '2026-08-12', isDone: () => false }), [])
  assert.deepEqual(catchUpPeriods({ cadence: 'adhoc', periodKey: 'adhoc', today: '2026-08-12', isDone: () => false }), [])
  // Trimestre : le T2 terminé remonte, le T3 en cours non.
  const tri = catchUpPeriods({
    cadence: 'trimestriel', periodKey: '2026-Q3', today: '2026-08-12',
    createdDay: '2020-01-01', isDone: () => false, depth: 2,
  })
  assert.deepEqual(tri.map(p => p.period_key), ['2026-Q2', '2026-Q1'])
})

test('isValidPeriodKey : une clé qui ne colle pas à la cadence est refusée', () => {
  assert.equal(isValidPeriodKey('mensuel', '2026-08'), true)
  assert.equal(isValidPeriodKey('mensuel', '2026-W32'), false)
  assert.equal(isValidPeriodKey('hebdo', '2026-W32'), true)
  assert.equal(isValidPeriodKey('hebdo', '2026-08'), false)
  assert.equal(isValidPeriodKey('adhoc', 'adhoc'), true)
  assert.equal(isValidPeriodKey('adhoc', '2026-08'), false)
})

// ── Deux fois par semaine (mardi et samedi) ───────────────────────────────────
// La semaine est coupée en deux créneaux cochés séparément : c'est ce découpage
// qui fait qu'une case cochée le mardi se retrouve vide le samedi.

test('bihebdo : lundi→vendredi = créneau mardi, samedi→dimanche = créneau samedi', () => {
  // Semaine du lundi 10 août 2026 (W33).
  assert.equal(periodKeyFor('bihebdo', '2026-08-10'), '2026-W33-1') // lundi
  assert.equal(periodKeyFor('bihebdo', '2026-08-11'), '2026-W33-1') // mardi
  assert.equal(periodKeyFor('bihebdo', '2026-08-14'), '2026-W33-1') // vendredi
  assert.equal(periodKeyFor('bihebdo', '2026-08-15'), '2026-W33-2') // samedi
  assert.equal(periodKeyFor('bihebdo', '2026-08-16'), '2026-W33-2') // dimanche
  // Le lundi suivant rouvre le créneau du mardi, dans la semaine d'après.
  assert.equal(periodKeyFor('bihebdo', '2026-08-17'), '2026-W34-1')
})

test('bihebdo : cocher le mardi ne coche pas le samedi', () => {
  // Le cœur de la demande : deux clés distinctes dans la même semaine.
  assert.notEqual(periodKeyFor('bihebdo', '2026-08-11'), periodKeyFor('bihebdo', '2026-08-15'))
})

test('bihebdo : bornes et libellé des créneaux', () => {
  assert.deepEqual(periodRange('bihebdo', '2026-W33-1'), { start: '2026-08-10', end: '2026-08-14' })
  assert.deepEqual(periodRange('bihebdo', '2026-W33-2'), { start: '2026-08-15', end: '2026-08-16' })
  assert.equal(periodRange('bihebdo', '2026-W33'), null, 'une clé sans créneau ne vaut rien')
  assert.equal(periodRange('bihebdo', '2026-W33-3'), null, 'il n\'y a que deux créneaux')
  assert.equal(periodLabel('bihebdo', '2026-08-11'), 'semaine 33', 'la section couvre la semaine entière')
})

test('bihebdo : clés valides / refusées', () => {
  assert.equal(isValidPeriodKey('bihebdo', '2026-W33-1'), true)
  assert.equal(isValidPeriodKey('bihebdo', '2026-W33-2'), true)
  assert.equal(isValidPeriodKey('bihebdo', '2026-W33'), false, 'une clé hebdo écrirait une complétion fantôme')
  assert.equal(isValidPeriodKey('hebdo', '2026-W33-1'), false)
})

test('slotFromKey : la clé porte son créneau', () => {
  assert.equal(slotFromKey('2026-W33-1').label, 'mardi')
  assert.equal(slotFromKey('2026-W33-2').label, 'samedi')
  assert.equal(slotFromKey('2026-W33'), null)
})

test('biweeklyOccurrences : deux cases, celle du jour repérée, celle ratée aussi', () => {
  // On est le samedi 15 août : le créneau du mardi est terminé et jamais coché.
  const occ = biweeklyOccurrences({ weekKey: '2026-W33', today: '2026-08-15', isDone: () => null })
  assert.deepEqual(occ.map(o => o.period_key), ['2026-W33-1', '2026-W33-2'])
  assert.deepEqual(occ.map(o => o.label), ['mardi', 'samedi'])
  assert.deepEqual(occ.map(o => o.due_date), ['2026-08-11', '2026-08-15'])
  assert.deepEqual(occ.map(o => o.is_current), [false, true])
  assert.deepEqual(occ.map(o => o.is_past), [true, false])
  assert.deepEqual(occ.map(o => o.done), [false, false])

  // Mardi coché : la case du mardi est faite, celle du samedi reste ouverte —
  // c'est exactement le décochage demandé.
  const partiel = biweeklyOccurrences({
    weekKey: '2026-W33', today: '2026-08-15',
    isDone: k => (k === '2026-W33-1' ? { done_at: '2026-08-11T14:00:00.000Z' } : null),
  })
  assert.deepEqual(partiel.map(o => o.done), [true, false])

  // Semaine à venir : rien n'est « en cours » ni « raté ».
  const future = biweeklyOccurrences({ weekKey: '2026-W35', today: '2026-08-15', isDone: () => null })
  assert.deepEqual(future.map(o => o.is_current), [false, false])
  assert.deepEqual(future.map(o => o.is_past), [false, false])
})
