// Moteur de période de service : libellés, période imprimée retrouvée dans le
// document, et déduction depuis le cycle de facturation déclaré (/abonnements-
// fournisseurs). Cas fondateur : Google Workspace, facturé le dernier jour du mois
// couvert, publié dans QB sans période parce que l'IA n'avait rien rempli.

import test from 'node:test'
import assert from 'node:assert/strict'

const { formatPeriodRange, findPeriodInText, derivePeriodFromSubscription, resolveServicePeriod, matchSubscriptions } =
  await import('./servicePeriod.js')

// ─── Libellés ────────────────────────────────────────────────────────────────

test('libellés de période', () => {
  const d = (y, m, day) => ({ y, m, d: day })
  assert.equal(formatPeriodRange(d(2026, 7, 1), d(2026, 7, 31)), 'juillet 2026')
  assert.equal(formatPeriodRange(d(2026, 7, 1), d(2026, 9, 30)), 'juillet–septembre 2026')
  assert.equal(formatPeriodRange(d(2026, 1, 1), d(2026, 12, 31)), 'année 2026')
  assert.equal(formatPeriodRange(d(2026, 7, 15), d(2026, 8, 14)), '15 juil. – 14 août 2026')
  assert.equal(formatPeriodRange(d(2026, 11, 12), d(2027, 11, 11)), '12 nov. 2026 – 11 nov. 2027')
  assert.equal(formatPeriodRange(d(2026, 2, 1), d(2026, 2, 28)), 'février 2026')
  // Bornes incohérentes → pas de libellé inventé.
  assert.equal(formatPeriodRange(d(2026, 8, 1), d(2026, 7, 1)), null)
})

// ─── Période imprimée sur le document ────────────────────────────────────────

test('période imprimée : formats FR et EN', () => {
  assert.equal(findPeriodInText('Billing period: Jul 1, 2026 - Jul 31, 2026'), 'juillet 2026')
  assert.equal(findPeriodInText('Période de facturation du 15/07/2026 au 14/08/2026'), '15 juil. – 14 août 2026')
  assert.equal(findPeriodInText('Service period 2026-07-01 to 2026-09-30'), 'juillet–septembre 2026')
  // Millésime absent : celui de la facture (cas Google Workspace « Engagement 1 juin - 30 juin »).
  assert.equal(findPeriodInText('Google Workspace — Engagement 1 juin - 30 juin', '2026-06-30'), 'juin 2026')
  // Période à cheval sur deux années.
  assert.equal(findPeriodInText('Abonnement du 15 déc. au 14 janv.', '2026-12-15'), '15 déc. 2026 – 14 janv. 2027')
})

test('période imprimée : rien à inventer', () => {
  assert.equal(findPeriodInText('Facture 5637718480 — payée le 2026-07-31'), null)
  assert.equal(findPeriodInText('Câble HDMI 2 m, quantité 3'), null)
  assert.equal(findPeriodInText(''), null)
  assert.equal(findPeriodInText(null), null)
  // Deux dates éloignées de plus de 18 mois : ce n'est pas une période de service.
  assert.equal(findPeriodInText('Période du 2020-01-01 au 2026-12-31'), null)
})

// ─── Déduction depuis le cycle de facturation déclaré ────────────────────────

const sub = o => ({ vendor: 'Google', plan: 'Google Workspace', frequency: 'Mensuel', billing_day: 1, period: 'Mois passé', amount: 184.19, ...o })
const receipt = o => ({ company: 'Google LLC', receipt_date: '2026-07-31', general_description: 'Abonnement Google Workspace Business Standard', items: [{ description: 'Google Workspace Business Standard', total: 184.19 }], total: 184.19, ...o })

test('Google Workspace : facturé le dernier jour du mois couvert → juillet 2026', () => {
  assert.equal(derivePeriodFromSubscription(receipt(), [sub()]), 'juillet 2026')
})

test('facturé le 1er du mois suivant, à terme échu → mois précédent', () => {
  assert.equal(derivePeriodFromSubscription(receipt({ receipt_date: '2026-08-01' }), [sub()]), 'juillet 2026')
})

test('facturé d\'avance le 1er → mois de la facture', () => {
  assert.equal(
    derivePeriodFromSubscription(receipt({ receipt_date: '2026-08-01' }), [sub({ period: 'Mois à venir' })]),
    'août 2026',
  )
})

test('cycle décalé dans le mois → intervalle, pas un mois civil', () => {
  assert.equal(
    derivePeriodFromSubscription(
      receipt({ company: 'Bell', receipt_date: '2026-07-22', general_description: 'Services Internet Affaires' }),
      [sub({ vendor: 'Bell', plan: 'Services Internet Affaires', billing_day: 22, period: 'Mois à venir', amount: null })],
    ),
    '22 juil. – 21 août 2026',
  )
})

test('abonnement annuel facturé d\'avance', () => {
  assert.equal(
    derivePeriodFromSubscription(
      receipt({ company: 'Ionos', receipt_date: '2026-11-12', general_description: 'Licence SSL Starter Wildcard', items: [], total: 100 }),
      [sub({ vendor: 'Ionos', plan: 'SSL Starter', frequency: 'Annuel', billing_day: 12, billing_month: 11, period: 'Année à venir', amount: 100 })],
    ),
    '12 nov. 2026 – 11 nov. 2027',
  )
})

test('pas de déduction sans convention de cycle exploitable', () => {
  assert.equal(derivePeriodFromSubscription(receipt(), [sub({ period: null })]), null)
  assert.equal(derivePeriodFromSubscription(receipt(), [sub({ billing_day: null })]), null)
  // Annuel sans mois de facturation : l'ancre est indéterminable.
  assert.equal(derivePeriodFromSubscription(receipt(), [sub({ frequency: 'Annuel', billing_month: null })]), null)
  // Deux abonnements actifs qui ne concordent pas : abstention.
  assert.equal(derivePeriodFromSubscription(receipt(), [sub(), sub({ period: 'Mois à venir' })]), null)
})

test('achat ponctuel chez un fournisseur par ailleurs abonné : aucune période', () => {
  const oneOff = receipt({
    general_description: 'Écran Pixel Tablet',
    items: [{ description: 'Pixel Tablet 11 po', total: 899 }],
    total: 899,
  })
  assert.equal(derivePeriodFromSubscription(oneOff, [sub()]), null)
})

test('abonnement à consommation variable : période quand même déduite', () => {
  const aws = receipt({
    company: 'Amazon Web Services',
    receipt_date: '2026-08-01',
    general_description: 'Services infonuagiques',
    items: [{ description: 'EC2 / VPC', total: 312.44 }],
    total: 312.44,
  })
  const awsSub = sub({ vendor: 'Amazon Web Services', plan: 'EC2/VPC', amount: null, variable: 1, period: 'Mois passé' })
  assert.equal(derivePeriodFromSubscription(aws, [awsSub]), 'juillet 2026')
})

// ─── Rattachement fournisseur ↔ abonnement ───────────────────────────────────

test('rattachement du fournisseur à son abonnement', () => {
  const subs = [
    { vendor: 'Google' }, { vendor: 'Google Play (Call recorder)' },
    { vendor: 'Amazon Web Services' }, { vendor: 'Amazon Prime' },
    { vendor: 'Bell' }, { vendor: 'Bell Mobilité' }, { vendor: 'MANYCHAT.COM' },
  ]
  const names = c => matchSubscriptions(c, subs).map(s => s.vendor)
  assert.deepEqual(names('Google LLC'), ['Google'])
  assert.deepEqual(names('Amazon Web Services Canada, Inc.'), ['Amazon Web Services'])
  // Une facture « Amazon » (matériel) n'hérite pas du cycle d'AWS ni de Prime.
  assert.deepEqual(names('Amazon'), [])
  // Le préfixe le plus long gagne.
  assert.deepEqual(names('Bell Mobilité'), ['Bell Mobilité'])
  assert.deepEqual(names('Bell Canada'), ['Bell'])
  // Suffixe purement corporatif côté abonnement : toléré.
  assert.deepEqual(names('Manychat'), ['MANYCHAT.COM'])
  assert.deepEqual(names('Fournisseur inconnu'), [])
})

// ─── Résolution : ordre de confiance ─────────────────────────────────────────

test('la période extraite par l\'IA prime sur tout', () => {
  const r = resolveServicePeriod(receipt(), '15 juil. – 14 août 2026', 'Billing period: Jul 1 - Jul 31, 2026')
  assert.deepEqual(r, { period: '15 juil. – 14 août 2026', source: 'ai' })
})

test('à défaut, la période imprimée sur le document', () => {
  const r = resolveServicePeriod(receipt({ company: 'Fournisseur inconnu inc' }), null, 'Billing period: Jul 1, 2026 - Jul 31, 2026')
  assert.deepEqual(r, { period: 'juillet 2026', source: 'document' })
})

test('facture ponctuelle d\'un fournisseur inconnu : pas de période', () => {
  const r = resolveServicePeriod({
    company: 'Quincaillerie du coin',
    receipt_date: '2026-07-31',
    general_description: 'Pièces de plomberie',
    items: [{ description: 'Raccord 1/2 po', total: 12.5 }],
    total: 12.5,
  })
  assert.deepEqual(r, { period: null, source: null })
})
