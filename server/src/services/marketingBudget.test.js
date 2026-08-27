import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entriesFromGlReport, matchRule, buildWeeklyMessage, isoWeekKey, isoWeekday,
  fiscalMonths, vendorKey, shouldSendWeekly, previousWeekRangeFr,
} from './marketingBudget.js'

// ── entriesFromGlReport ──────────────────────────────────────────────────────
// Forme réelle du rapport GeneralLedger QB (colonnes par ColKey, lignes
// imbriquées sous des sections, « Solde initial » et totaux sans date).

const COLS = ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'currency', 'debt_amt', 'credit_amt', 'debt_home_amt', 'credit_home_amt']
const col = (v, id) => ({ value: v, ...(id ? { id } : {}) })
const report = (rows) => ({
  Columns: { Column: COLS.map(k => ({ MetaData: [{ Name: 'ColKey', Value: k }] })) },
  Rows: { Row: [{ Rows: { Row: rows.map(r => ({ ColData: r })) } }] },
})

test('parse GL : dépense CAD simple, montant maison signé au débit', () => {
  const rows = [
    [col('Solde initial'), col(''), col(''), col(''), col(''), col(''), col(''), col(''), col(''), col('')],
    [col('2026-07-29'), col('Facture à payer', '17778'), col('4623'), col("Les Jardins D'Inverness"), col('Consultation — juillet'), col('CAD'), col('5000.00'), col(''), col('5000.00'), col('')],
  ]
  const entries = entriesFromGlReport(report(rows), { acctnum: '75910', accountLabel: 'Consultants' })
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.equal(e.amount, 5000)
  assert.equal(e.currency, 'CAD')
  assert.equal(e.amount_foreign, null)
  assert.equal(e.qb_txn_id, '17778')
  assert.equal(e.acctnum, '75910')
  assert.equal(e.vendor, "Les Jardins D'Inverness")
})

test('parse GL : devise étrangère — montant maison retenu, étranger conservé', () => {
  const rows = [
    [col('2026-07-21'), col('Dépense', '17745'), col('49024547'), col('HubSpot - USD'), col('Subscription'), col('USD'), col('854.75'), col(''), col('1204.77'), col('')],
  ]
  const [e] = entriesFromGlReport(report(rows), { acctnum: '75920', accountLabel: 'Publicité et promotion' })
  assert.equal(e.amount, 1204.77)
  assert.equal(e.amount_foreign, 854.75)
  assert.equal(e.currency, 'USD')
})

test('parse GL : crédit (remboursement) = montant négatif ; lignes jumelles suffixées', () => {
  const twin = [col('2026-06-15'), col('Dépense', '17545'), col('1560471-1'), col('Montego Club'), col('Pourboire'), col('CAD'), col('7.04'), col(''), col('7.04'), col('')]
  const rows = [
    twin, twin,
    [col('2026-06-20'), col('Crédit de fournisseur', '18000'), col(''), col('Montego Club'), col('Remb.'), col('CAD'), col(''), col('7.04'), col(''), col('7.04')],
  ]
  const entries = entriesFromGlReport(report(rows), { acctnum: '75930', accountLabel: 'Repas aux fins de promotion' })
  assert.equal(entries.length, 3)
  assert.notEqual(entries[0].import_key, entries[1].import_key)
  assert.ok(entries[1].import_key.endsWith('#2'))
  assert.equal(entries[2].amount, -7.04)
})

// ── matchRule ────────────────────────────────────────────────────────────────

const rule = (label, acctnum = null) => ({ id: 'r1', vendor_key: vendorKey(label), vendor_label: label, acctnum })

test('règle : fournisseur normalisé (accents, casse, ponctuation), contenance bilatérale', () => {
  assert.ok(matchRule([rule('Café Temps Perdu')], { vendor: 'CAFE TEMPS-PERDU', acctnum: '75930' }))
  assert.ok(matchRule([rule('HubSpot')], { vendor: 'HubSpot - USD', acctnum: '75920' }))
  assert.equal(matchRule([rule('HubSpot')], { vendor: 'Montego Club', acctnum: '75930' }), null)
  assert.equal(matchRule([rule('HubSpot')], { vendor: null, acctnum: '75920' }), null)
})

test('règle : bornée à un compte quand acctnum est présent', () => {
  assert.ok(matchRule([rule('Montego', '75930')], { vendor: 'Montego Club', acctnum: '75930' }))
  assert.equal(matchRule([rule('Montego', '75930')], { vendor: 'Montego Club', acctnum: '75920' }), null)
})

// ── buildWeeklyMessage ───────────────────────────────────────────────────────

test('message hebdo : une puce par dépense, devise étrangère affichée, total', () => {
  const msg = buildWeeklyMessage([
    { txn_date: '2026-07-21', vendor: 'HubSpot - USD', memo: 'Subscription', amount: 1204.77, amount_foreign: 854.75, currency: 'USD', account_name: 'Publicité et promotion' },
    { txn_date: '2026-07-29', vendor: "Les Jardins D'Inverness", memo: null, amount: 5000, amount_foreign: null, currency: 'CAD', account_name: 'Consultants' },
  ], { dayIso: '2026-08-11' })
  assert.match(msg, /semaine du 3 au 9 août/)
  assert.match(msg, /HubSpot - USD — Subscription/)
  assert.match(msg, /854,75.*US/) // montant d'origine USD affiché
  assert.match(msg, /Publicité et promotion/)
  assert.match(msg, /Total/)
  assert.equal(msg.split('\n').length, 4) // header + 2 puces + total
})

test('message hebdo : aucune dépense → message court explicite', () => {
  const msg = buildWeeklyMessage([], { dayIso: '2026-08-11' })
  assert.match(msg, /Aucune nouvelle dépense pertinente/)
})

// ── shouldSendWeekly ─────────────────────────────────────────────────────────
// Le message ne doit jamais affirmer « aucune dépense pertinente » alors que des
// lignes attendent seulement d'être triées : Émilie en conclurait qu'il ne s'est
// rien passé.

test('envoi retenu : rien de validé mais des dépenses encore à valider', () => {
  const gate = shouldSendWeekly({ relevantCount: 0, pendingCount: 12 })
  assert.equal(gate.send, false)
  assert.match(gate.reason, /12 dépense\(s\) encore à valider/)
})

test('envoi fait : des dépenses validées à annoncer (même s\'il reste des pending)', () => {
  assert.equal(shouldSendWeekly({ relevantCount: 3, pendingCount: 9 }).send, true)
  assert.equal(shouldSendWeekly({ relevantCount: 1, pendingCount: 0 }).send, true)
})

test('envoi fait : semaine réellement vide (rien en attente, rien de pertinent)', () => {
  assert.equal(shouldSendWeekly({ relevantCount: 0, pendingCount: 0 }).send, true)
})

// ── Calendrier ───────────────────────────────────────────────────────────────

test('previousWeekRangeFr : semaine précédente, même mois', () => {
  assert.equal(previousWeekRangeFr('2026-08-11'), '3 au 9 août') // mardi 11 août → semaine du 3-9 août
})

test('previousWeekRangeFr : semaine précédente à cheval sur deux mois', () => {
  assert.equal(previousWeekRangeFr('2026-08-04'), '27 juillet au 2 août') // mardi 4 août → semaine du 27 juillet au 2 août
})

test('isoWeekday et isoWeekKey', () => {
  assert.equal(isoWeekday('2026-08-11'), 2) // mardi
  assert.equal(isoWeekday('2026-08-09'), 7) // dimanche
  assert.equal(isoWeekKey('2026-08-11'), isoWeekKey('2026-08-10')) // même semaine ISO
  assert.notEqual(isoWeekKey('2026-08-11'), isoWeekKey('2026-08-18')) // mardis consécutifs
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01')
})

test('fiscalMonths : avril → mars', () => {
  const months = fiscalMonths('2026')
  assert.equal(months.length, 12)
  assert.equal(months[0], '2026-04')
  assert.equal(months[8], '2026-12')
  assert.equal(months[9], '2027-01')
  assert.equal(months[11], '2027-03')
})
