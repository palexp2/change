import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextPayDay, scheduleWindow, bucketOf, coveredByRecurring, groupByVendor, projectCard,
} from './paymentSchedule.js'

// ── Fenêtre de la cédule = le cycle réel de paiement ─────────────────────────
// Les factures se paient le MARDI, et ce jour-là on règle tout ce qui échoit
// avant le mercredi suivant (donc jusqu'au mardi d'après inclus : un paiement
// émis le mardi soir ne passe à la banque que le lendemain).

test('la séance de paiement est le mardi — aujourd\'hui si on y est déjà', () => {
  assert.equal(nextPayDay('2026-08-11'), '2026-08-11')  // mardi
  assert.equal(nextPayDay('2026-08-12'), '2026-08-18')  // mercredi → mardi suivant
  assert.equal(nextPayDay('2026-08-10'), '2026-08-11')  // lundi → demain
  assert.equal(nextPayDay('2026-08-16'), '2026-08-18')  // dimanche → surlendemain
})

test('la fenêtre va jusqu\'au mardi suivant inclus, et s\'arrête au mercredi', () => {
  const w = scheduleWindow('2026-08-11')
  assert.equal(w.pay_day, '2026-08-11')
  assert.equal(w.end, '2026-08-18')      // mardi suivant : encore payé aujourd'hui
  assert.equal(w.cutoff, '2026-08-19')   // mercredi : plus dans la cédule
  // Consultée un jeudi, la cédule est celle de la prochaine séance (le mardi).
  const jeudi = scheduleWindow('2026-08-13')
  assert.equal(jeudi.pay_day, '2026-08-18')
  assert.equal(jeudi.end, '2026-08-25')
  // Franchit le changement de mois sans arithmétique maison.
  assert.equal(scheduleWindow('2026-08-25').end, '2026-09-01')
})

// ── Répartition en retard / cette semaine / plus tard ────────────────────────

test('échéance dépassée = en retard, dans la fenêtre = cette semaine, après = plus tard', () => {
  const w = scheduleWindow('2026-08-11')   // mardi → fenêtre jusqu'au 18 inclus
  assert.equal(bucketOf('2026-08-01', '2026-08-11', w.end), 'late')
  assert.equal(bucketOf('2026-08-11', '2026-08-11', w.end), 'week')
  assert.equal(bucketOf('2026-08-18', '2026-08-11', w.end), 'week')   // mardi suivant : inclus
  assert.equal(bucketOf('2026-08-19', '2026-08-11', w.end), 'later')  // mercredi : exclu
  // Sans échéance : à traiter tout de suite plutôt qu'à oublier au fond.
  assert.equal(bucketOf(null, '2026-08-11', w.end), 'week')
})

// ── Anti double-compte : facture couverte par une sortie récurrente ──────────
// Le loyer est à la fois une récurrente et une facture du bailleur ; sans ce
// filtre, la semaine proposerait de payer une deuxième fois ce qui part tout
// seul. L'appariement n'a lieu que sur vendor_match, posé à la main.

const occurrence = { label: 'Loyer', date: '2026-08-04', amount: 6115.89, vendor_match: 'Inverness' }

test('facture du fournisseur nommé et datée près de l\'occurrence = couverte', () => {
  const bills = [{ id: 'b1', vendor: "Les Jardins d'Inverness", due_date: '2026-08-05' }]
  assert.equal(coveredByRecurring(bills, [occurrence]).get('b1')?.label, 'Loyer')
})

test('même fournisseur mais hors fenêtre, ou autre fournisseur = pas couverte', () => {
  const loin = [{ id: 'b2', vendor: "Les Jardins d'Inverness", due_date: '2026-09-30' }]
  assert.equal(coveredByRecurring(loin, [occurrence]).size, 0)
  const autre = [{ id: 'b3', vendor: 'Negotel', due_date: '2026-08-05' }]
  assert.equal(coveredByRecurring(autre, [occurrence]).size, 0)
})

test('récurrente sans vendor_match ne couvre jamais rien', () => {
  const bills = [{ id: 'b4', vendor: 'Loyer', due_date: '2026-08-04' }]
  assert.equal(coveredByRecurring(bills, [{ ...occurrence, vendor_match: null }]).size, 0)
})

// ── Regroupement par fournisseur ─────────────────────────────────────────────

test('un groupe par fournisseur, le plus urgent en tête, devises séparées', () => {
  const groups = groupByVendor([
    { id: '1', vendor: 'Novo Express', due_date: '2026-08-20', amount: 32.63, currency: 'CAD' },
    { id: '2', vendor: 'Negotel', due_date: '2026-08-10', amount: 37.15, currency: 'CAD' },
    { id: '3', vendor: 'novo express', due_date: '2026-08-14', amount: 214.79, currency: 'CAD' },
    { id: '4', vendor: 'Axxess', due_date: '2026-08-19', amount: 48.29, currency: 'USD' },
  ])
  assert.deepEqual(groups.map(g => g.key), ['negotel', 'novoexpress', 'axxess'])
  assert.equal(groups[1].items.length, 2)
  assert.equal(groups[1].total_cad, 247.42)
  // Une facture USD ne se fond pas dans le total CAD.
  assert.equal(groups[2].total_cad, 0)
  assert.deepEqual(groups[2].currencies, { USD: 48.29 })
})

// ── Solde projeté de la carte ────────────────────────────────────────────────

test('solde projeté = relevé + achats en attente + cédule − paiements de carte', () => {
  assert.equal(projectCard({
    current: 1726.04, charges_pending: 500, scheduled: 9000, card_payments: 1072.86,
  }), 10153.18)
  // Sans rien d'autre, le solde projeté est celui du relevé.
  assert.equal(projectCard({ current: 1726.04 }), 1726.04)
})
