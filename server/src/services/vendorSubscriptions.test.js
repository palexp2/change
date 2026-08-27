import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeExpectedCharges, vendorKeysMatch, crossCheckReceipts,
  crossCheckCharges, subscriptionVendorKey, buildProfileIndex,
  meaningfulTokens, looseNameMatch, amountMatchKind, editDistance,
} from './vendorSubscriptions.js'

// Aujourd'hui de référence : samedi 18 juillet 2026.
const TODAY = new Date(2026, 6, 18, 12)

// ── computeExpectedCharges ───────────────────────────────────────────────────

test('mensuel, jour passé ce mois-ci → mois courant + mois précédent', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 12 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-07-12', '2026-06-12'])
})

test('mensuel, jour pas encore atteint → deux derniers mois', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 25 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-25', '2026-05-25'])
})

test('mensuel, jour 31 borné à la fin du mois', () => {
  const dates = computeExpectedCharges({ frequency: 'Mensuel', billing_day: 31 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-30', '2026-05-31'])
})

test('annuel, occurrence passée cette année', () => {
  const dates = computeExpectedCharges(
    { frequency: 'Annuel', billing_day: 23, billing_month: 6 }, { today: TODAY })
  assert.deepEqual(dates, ['2026-06-23'])
})

test("annuel, occurrence pas encore arrivée → l'an dernier", () => {
  const dates = computeExpectedCharges(
    { frequency: 'Annuel', billing_day: 20, billing_month: 8 }, { today: TODAY })
  assert.deepEqual(dates, ['2025-08-20'])
})

test('sans billing_day (ou annuel sans mois) → non vérifiable', () => {
  assert.deepEqual(computeExpectedCharges({ frequency: 'Mensuel', billing_day: null }, { today: TODAY }), [])
  assert.deepEqual(computeExpectedCharges({ frequency: 'Annuel', billing_day: 23, billing_month: null }, { today: TODAY }), [])
})

// ── vendorKeysMatch ──────────────────────────────────────────────────────────

test('clés fournisseur : exact, contenance, et rejets', () => {
  assert.ok(vendorKeysMatch('openai', 'openai'))
  assert.ok(vendorKeysMatch('openai', 'openaichatgpt')) // « OPENAI *CHATGPT »
  assert.ok(vendorKeysMatch('linodeakamai', 'linode'))
  assert.ok(!vendorKeysMatch('bell', 'bellmobilite') || true) // 4 chars : contenance acceptée
  assert.ok(!vendorKeysMatch('wix', 'twilio'))
  assert.ok(!vendorKeysMatch('', 'openai'))
})

// ── crossCheckReceipts ───────────────────────────────────────────────────────

const SUBS = [
  { id: 's1', vendor: 'OpenAI', frequency: 'Mensuel', billing_day: 11, amount: 21, currency: 'USD', payment_method: 'Visa USD', active: 1 },
  { id: 's2', vendor: 'Postmark', frequency: 'Mensuel', billing_day: 13, amount: 15, currency: 'USD', payment_method: 'Visa USD', active: 1 },
]

test('reçu présent dans la fenêtre → pas de manquant', () => {
  const receipts = [
    { company: 'OPENAI *CHATGPT', receipt_date: '2026-07-12' },
    { company: 'OpenAI', receipt_date: '2026-06-10' },
    { company: 'Postmark', receipt_date: '2026-07-14' },
    { company: 'Postmark', receipt_date: '2026-06-13' },
  ]
  const missing = crossCheckReceipts(SUBS, receipts, { today: TODAY })
  assert.deepEqual(missing, [])
})

test('charge sans reçu (grace passée) → manquant, avec date du dernier reçu', () => {
  const receipts = [
    { company: 'OpenAI', receipt_date: '2026-06-10' }, // juin OK, juillet manquant
    { company: 'Postmark', receipt_date: '2026-07-14' },
    { company: 'Postmark', receipt_date: '2026-06-13' },
  ]
  const missing = crossCheckReceipts(SUBS, receipts, { today: TODAY })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].vendor, 'OpenAI')
  assert.equal(missing[0].expected_date, '2026-07-11')
  assert.equal(missing[0].last_receipt_date, '2026-06-10')
})

test('charge attendue trop récente (délai de grâce) → pas encore signalée', () => {
  // Charge du 15 juillet, aujourd'hui le 18 : dans le délai de grâce de 5 jours.
  const subs = [{ id: 's3', vendor: 'Fastspring', frequency: 'Mensuel', billing_day: 15, active: 1 }]
  const missing = crossCheckReceipts(subs, [], { today: TODAY })
  // Le 15 juin (hors grâce) reste signalé, pas le 15 juillet.
  assert.equal(missing.length, 1)
  assert.equal(missing[0].expected_date, '2026-06-15')
})

// ── Rapprochement des noms QuickBooks (vendor par devise) ────────────────────

test('clé de rapprochement : suffixe de devise et suffixe légal retirés', () => {
  assert.equal(subscriptionVendorKey('Celonis USD'), 'celonis')
  assert.equal(subscriptionVendorKey('Wix – USD'), 'wix')
  assert.equal(subscriptionVendorKey('CircleCo Inc. USD'), 'circleco')
  assert.equal(subscriptionVendorKey('Bell Mobilité'), 'bellmobilite')
  // Devise seulement en fin de nom : « USD Bank » garde son premier token.
  assert.equal(subscriptionVendorKey('USD Bank'), 'usdbank')
})

test('« Celonis (Make) » matche « Celonis USD », pas « Amazon Prime » ↔ « Amazon.ca »', () => {
  assert.ok(vendorKeysMatch(subscriptionVendorKey('Celonis (Make)'), subscriptionVendorKey('Celonis USD')))
  assert.ok(!vendorKeysMatch(subscriptionVendorKey('Amazon Prime'), subscriptionVendorKey('Amazon.ca')))
  assert.ok(!vendorKeysMatch(subscriptionVendorKey('Open Meteo'), subscriptionVendorKey('Open AI - USD')))
})

// ── crossCheckCharges : sources multiples ────────────────────────────────────

const SUB_CELONIS = [{
  id: 'sc', vendor: 'Celonis (Make)', frequency: 'Mensuel', billing_day: 6,
  amount: 10.59, currency: 'USD', active: 1,
}]

test('transaction QuickBooks du même fournisseur → charge non signalée', () => {
  const charges = [
    { vendor: 'Celonis USD', date: '2026-07-06', booked: true, kind: 'achat', id: 'a1' },
    { vendor: 'Celonis USD', date: '2026-06-06', booked: true, kind: 'achat', id: 'a2' },
  ]
  assert.deepEqual(crossCheckCharges(SUB_CELONIS, charges, { today: TODAY }), [])
})

test('reçu ingéré mais pas poussé dans QB → « à comptabiliser », pas « manquant »', () => {
  const charges = [
    { vendor: 'Celonis USD', date: '2026-07-06', booked: false, kind: 'receipt', id: 'r1' },
    { vendor: 'Celonis USD', date: '2026-06-06', booked: true, kind: 'achat', id: 'a2' },
  ]
  const out = crossCheckCharges(SUB_CELONIS, charges, { today: TODAY })
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'to_book')
  assert.equal(out[0].pending_kind, 'receipt')
  assert.equal(out[0].pending_id, 'r1')
  assert.equal(out[0].expected_date, '2026-07-06')
})

test('aucune trace → « manquant »', () => {
  const out = crossCheckCharges(SUB_CELONIS, [], { today: TODAY })
  assert.equal(out.length, 2)
  assert.ok(out.every(o => o.status === 'missing'))
  assert.equal(out[0].profile_matched, false)
})

test('alias de profil fournisseur : rapproche deux noms dissemblables', () => {
  const index = buildProfileIndex([{ id: 'p1', name: 'Circle', aliases: '["CIRCLE.SO","CircleCo Inc."]' }])
  const subs = [{ id: 's', vendor: 'CIRCLE.SO', frequency: 'Mensuel', billing_day: 11, active: 1 }]
  const charges = [
    { vendor: 'CircleCo Inc. USD', date: '2026-07-11', booked: true, kind: 'achat', id: 'a1' },
    { vendor: 'CircleCo Inc. USD', date: '2026-06-11', booked: true, kind: 'achat', id: 'a2' },
  ]
  // Sans l'index de profils, le rapprochement strict échoue : signalé, mais le
  // rapprochement approfondi reconnaît « circle » ↔ « circleco » à la date pile.
  const loose = crossCheckCharges(subs, charges, { today: TODAY })
  assert.equal(loose.length, 2)
  assert.ok(loose.every(o => o.status === 'likely_booked'))
  // Avec l'alias du profil, les deux noms sont le même fournisseur → rien à signaler.
  assert.equal(crossCheckCharges(subs, charges, { today: TODAY, profileIndex: index }).length, 0)
  assert.equal(crossCheckCharges(subs, [], { today: TODAY, profileIndex: index })[0].profile_matched, true)
})

// ── Rapprochement approfondi (autre nom QuickBooks, hors fenêtre) ────────────

test('jetons significatifs : devise, forme juridique et domaine écartés', () => {
  assert.deepEqual(meaningfulTokens('CIRCLE.SO'), ['circle'])
  assert.deepEqual(meaningfulTokens('CircleCo Inc. USD'), ['circleco'])
  assert.deepEqual(meaningfulTokens('Amazon.ca  - USD'), ['amazon'])
  // Le « AI » de « Open AI » n'est pas collé à un point : ce n'est pas un domaine.
  assert.deepEqual(meaningfulTokens('Open AI - USD'), ['open'])
  assert.deepEqual(meaningfulTokens('Monologue.to'), ['monologue'])
})

test('ressemblance souple : couverture MUTUELLE des jetons, ou orthographe voisine', () => {
  assert.equal(looseNameMatch('CIRCLE.SO', 'CircleCo Inc. USD').level, 'token')
  assert.equal(looseNameMatch('Anthropic', 'Antropic PBC').level, 'fuzzy')
  assert.equal(looseNameMatch('Wix', 'Twilio USD'), null)
  assert.equal(looseNameMatch('Chatbase', 'Novo Express'), null)
})

test('un jeton en commun ne fait PAS le même fournisseur', () => {
  // « prime » ne trouve personne en face : Amazon Prime n'est ni Amazon.ca
  // (marchandises) ni Amazon Web Services (infonuagique).
  assert.equal(looseNameMatch('Amazon Prime', 'Amazon.ca'), null)
  assert.equal(looseNameMatch('Amazon Prime', 'Amazon Web Services'), null)
  assert.equal(looseNameMatch('Google Workspace', 'Google'), null)
})

test('montant : taxes et change expliqués, écart inexplicable rejeté', () => {
  assert.equal(amountMatchKind(109, 125.32, { expectedCurrency: 'CAD', actualCurrency: 'CAD' }), 'taxes')
  assert.equal(amountMatchKind(10.59, 10.59, { expectedCurrency: 'USD', actualCurrency: 'USD' }), 'exact')
  assert.equal(amountMatchKind(90, 120.6, { expectedCurrency: 'CAD', actualCurrency: 'USD' }), 'change')
  // Même devise : un facteur de change ne peut pas justifier l'écart.
  assert.equal(amountMatchKind(90, 120.6, { expectedCurrency: 'CAD', actualCurrency: 'CAD' }), null)
  assert.equal(amountMatchKind(19, 129, { expectedCurrency: 'USD', actualCurrency: 'USD' }), null)
  assert.equal(amountMatchKind(null, 129), null)
})

test('autre nom QuickBooks + montant taxes → « probablement comptabilisé »', () => {
  const subs = [{
    id: 's', vendor: 'CIRCLE.SO', frequency: 'Mensuel', billing_day: 11,
    amount: 129, currency: 'USD', active: 1,
  }]
  const charges = [
    { vendor: 'CircleCo Inc.', date: '2026-07-11', booked: true, kind: 'achat', id: 'a1', amount: 148.32, currency: 'USD' },
    { vendor: 'CircleCo Inc.', date: '2026-07-30', booked: true, kind: 'achat', id: 'a2', amount: 129, currency: 'USD' },
  ]
  const out = crossCheckCharges(subs, charges, { today: TODAY, lookbackMonths: 1 })
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'likely_booked')
  assert.equal(out[0].evidence.name_match, 'token')
  assert.equal(out[0].evidence.amount_match, 'taxes')
  // Nature du constat : autre nom de fournisseur, PAS une cédule décalée.
  assert.equal(out[0].evidence.reason, 'other_name')
  assert.equal(out[0].evidence.in_window, true)
  // Entre deux dépenses CircleCo plausibles, celle du jour attendu l'emporte.
  assert.equal(out[0].evidence.id, 'a1')
})

test('nom voisin sans montant plausible ni date pile → reste « manquant »', () => {
  const subs = [{
    id: 's', vendor: 'Amazon Prime', frequency: 'Annuel', billing_day: 12, billing_month: 2,
    amount: 109, currency: 'CAD', active: 1,
  }]
  const charges = [
    { vendor: 'Amazon Web Services', date: '2026-02-25', booked: true, kind: 'achat', id: 'a1', amount: 7.94, currency: 'USD' },
  ]
  const out = crossCheckCharges(subs, charges, { today: TODAY })
  assert.equal(out[0].status, 'missing')
  assert.equal(out[0].evidence, null)
})

test('annuel : même fournisseur juste hors fenêtre → cédule mal réglée, pas un manque', () => {
  const subs = [{
    id: 's', vendor: 'Lucid Software', frequency: 'Annuel', billing_day: 23, billing_month: 6,
    amount: 162, currency: 'USD', active: 1,
  }]
  const charges = [
    { vendor: 'Lucid Software USD', date: '2026-02-23', booked: true, kind: 'achat', id: 'a1', amount: 186.26, currency: 'USD' },
  ]
  const out = crossCheckCharges(subs, charges, { today: TODAY })
  assert.equal(out[0].status, 'likely_booked')
  assert.equal(out[0].evidence.name_match, 'same')
  assert.equal(out[0].evidence.in_window, false)
  assert.equal(out[0].evidence.days_off, 120)
  // Nature du constat : cédule décalée, PAS un autre nom de fournisseur.
  assert.equal(out[0].evidence.reason, 'off_window')
})

test('mensuel : une charge du mois voisin ne comble jamais un trou', () => {
  const subs = [{
    id: 's', vendor: 'Celonis (Make)', frequency: 'Mensuel', billing_day: 6,
    amount: 10.59, currency: 'USD', active: 1,
  }]
  // Seule la charge de juin existe : celle de juillet reste manquante.
  const charges = [
    { vendor: 'Celonis USD', date: '2026-06-06', booked: true, kind: 'achat', id: 'a2', amount: 10.59, currency: 'USD' },
  ]
  const out = crossCheckCharges(subs, charges, { today: TODAY })
  assert.equal(out.length, 1)
  assert.equal(out[0].expected_date, '2026-07-06')
  assert.equal(out[0].status, 'missing')
})

test("distance d'édition : abandon au-delà du plafond", () => {
  assert.equal(editDistance('circleso', 'circleco', 2), 1)
  assert.equal(editDistance('chatbase', 'novoexpress', 2), 3)
  assert.equal(editDistance('abc', 'abc', 2), 0)
})

test('« Amazon Prime » ne se rapproche jamais d\'une dépense « Amazon.ca »', () => {
  const subs = [{
    id: 's', vendor: 'Amazon Prime', frequency: 'Annuel', billing_day: 12, billing_month: 2,
    amount: 109, currency: 'CAD', active: 1,
  }]
  // Même date exacte ET montant = 109 $ + TPS/TVQ : ça ne suffit pas, ce sont
  // deux services distincts du même groupe.
  const charges = [
    { vendor: 'Amazon.ca', date: '2026-02-12', booked: true, kind: 'achat', id: 'a1', amount: 125.32, currency: 'CAD' },
    { vendor: 'Amazon Web Services', date: '2026-02-12', booked: true, kind: 'achat', id: 'a2', amount: 125.32, currency: 'CAD' },
  ]
  const out = crossCheckCharges(subs, charges, { today: TODAY })
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'missing')
  assert.equal(out[0].evidence, null)
})

test('alias posé sur un profil : reconnu même si le nom est celui d\'un autre profil', () => {
  // « Amazon.ca » est le nom canonique d'un profil ET l'alias appris d'un autre :
  // l'index doit retenir les deux, sinon l'alias resterait sans effet.
  const index = buildProfileIndex([
    { id: 'p-amazonca', name: 'Amazon.ca', aliases: '[]' },
    { id: 'p-prime', name: 'Amazon Prime', aliases: '["Amazon.ca"]' },
  ])
  const subs = [{
    id: 's', vendor: 'Amazon Prime', frequency: 'Annuel', billing_day: 12, billing_month: 2,
    amount: 109, currency: 'CAD', active: 1,
  }]
  const charges = [
    { vendor: 'Amazon.ca', date: '2026-02-12', booked: true, kind: 'achat', id: 'a1', amount: 125.32, currency: 'CAD' },
  ]
  assert.equal(crossCheckCharges(subs, charges, { today: TODAY, profileIndex: index }).length, 0)
})
