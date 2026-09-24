// Ce qui est vérifié ici : qu'un dossier soldé se taise, qu'une libération
// passée deux fois se voie, et qu'un client qui paie en deux versements ne
// passe pas pour un écart. Aucun appel réseau : les lignes du grand livre et
// les factures sont fournies à la main.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, parseRef, normalizeName, lineParty, groupLedger, correctionFor } from './deferredDeposits.js'

const F = (over = {}) => ({
  id: 'f1', document_number: '868A5792-0003', company_id: 'c1', company_name: 'Urban Roots London',
  deferred_revenue_at: '2026-06-22T00:00:00Z', revenue_recognized_at: null, ...over,
})
const credit = (n, over = {}) => ({ date: '2026-06-22', type: 'Dépôt', doc_num: '', name: '', memo: '', debit: 0, credit: n, ...over })
const debit = (n, over = {}) => ({ date: '2026-06-23', type: 'Écriture de journal', doc_num: '', name: '', memo: '', debit: n, credit: 0, ...over })

test('un montant se lit avec ses virgules, ses parenthèses et son dollar', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56)
  assert.equal(parseAmount('(500.00)'), -500)
  assert.equal(parseAmount('$26,700.00'), 26700)
  assert.equal(parseAmount(''), 0)
})

test('le numéro de facture se retrouve dans le mémo comme dans le numéro de pièce', () => {
  assert.equal(parseRef('Constatation #868A5792-0005'), '868A5792-0005')
  assert.equal(parseRef('23467A23-0764'), '23467A23-0764')
  assert.equal(parseRef('INTERAC E-TRANSFER'), null)
})

test('le même client s’écrit de plusieurs façons', () => {
  assert.equal(normalizeName('Au potager du paysan Inc.'), normalizeName('au potager du paysan'))
  assert.notEqual(normalizeName('Ferme Décembre'), normalizeName('Ferme Cyr 1935'))
})

test('un dépôt suivi de sa constatation ne laisse rien derrière', () => {
  const [g] = groupLedger(
    [credit(6111, { memo: '#868A5792-0003 — Urban Roots London · revenu reçu d\'avance' }),
      debit(6111, { memo: 'Constatation #868A5792-0003' })],
    [F()],
  )
  assert.equal(g.solde, 0)
  assert.equal(g.etat, 'Réglé')
  assert.deepEqual(g.anomalies, [])
})

test('une libération passée deux fois se voit, et sa correction repose le passif', () => {
  const [g] = groupLedger(
    [credit(2900, { memo: '#H88PM9MN-0003' }), debit(2900, { memo: 'Constatation #H88PM9MN-0003' }),
      debit(2900, { memo: 'Constatation #H88PM9MN-0003' })],
    [F({ id: 'f2', document_number: 'H88PM9MN-0003', company_name: 'Eat Local Muskoka' })],
  )
  assert.equal(g.solde, -2900)
  assert.equal(g.anomalies[0].code, 'libere_en_trop')
  const c = correctionFor(g)
  assert.equal(c.amount, 2900)
  // Le passif revient : crédit au 23900, débit aux ventes.
  assert.equal(c.lines.find(l => l.acctnum === '23900').posting, 'Credit')
  assert.equal(c.lines.find(l => l.acctnum === '40000').posting, 'Debit')
})

test('deux versements pour une même facture s’additionnent au lieu de faire deux écarts', () => {
  const lines = [
    credit(8697.54, { name: 'Les jardins Malbi', memo: 'Les jardins Malbi – Paiement 1 de 2' }),
    credit(3902.46, { name: 'Les jardins Malbi', memo: 'Les jardins Malbi – Paiement 2 de 2' }),
    debit(12600, { name: 'Les jardins Malbi', memo: 'Les jardins Malbi: Constatation de la vente' }),
  ]
  const [g] = groupLedger(lines, [F({ id: 'f3', document_number: 'ZZZZZZZZ-0001', company_name: 'Les jardins Malbi' })])
  assert.equal(g.versements, 2)
  assert.equal(g.multi_versements, true)
  assert.equal(g.solde, 0)
  assert.deepEqual(g.anomalies, [])
})

test('une commande expédiée dont le passif dort encore est signalée, et sa correction le libère', () => {
  const [g] = groupLedger(
    [credit(20880, { name: 'Black Creek Community Farm' })],
    [F({ id: 'f4', document_number: 'AAAAAAAA-0001', company_name: 'Black Creek Community Farm', revenue_recognized_at: '2026-09-01T00:00:00Z' })],
  )
  assert.equal(g.solde, 20880)
  assert.equal(g.anomalies[0].code, 'jamais_libere')
  const c = correctionFor(g)
  assert.equal(c.lines.find(l => l.acctnum === '23900').posting, 'Debit')
})

test('un dépôt encore ouvert n’est pas une anomalie : la commande n’est pas partie', () => {
  const [g] = groupLedger([credit(7700, { name: 'Artisans Maraichers' })],
    [F({ id: 'f5', document_number: 'JQGA5BF3-0002', company_name: 'Artisans Maraichers' })])
  assert.equal(g.etat, 'À constater')
  assert.deepEqual(g.anomalies, [])
})

test('une facture que l’ERP dit avoir posée mais absente du grand livre ne disparaît pas', () => {
  const groups = groupLedger([], [F({ id: 'f6', document_number: 'BBBBBBBB-0002', company_name: 'Ferme Test' })])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].anomalies[0].code, 'absent_du_grand_livre')
})

test('sur un reçu de vente, le client est dans le mémo — pas « Stripe CAD »', () => {
  assert.equal(lineParty({ name: 'Stripe CAD', memo: 'Atlantic Canada Greenhouse Supplies Ltd' }), 'Atlantic Canada Greenhouse Supplies Ltd')
  assert.equal(lineParty({ name: '', memo: 'Ferme Giroflée: Constatation de la vente' }), 'Ferme Giroflée')
  assert.equal(lineParty({ name: '', memo: "Solde d'ouverture" }), '')
})

test('le même client sous deux noms ne forme qu’un dossier', () => {
  const groups = groupLedger(
    [credit(175, { name: 'Coopérative Gaïa' }), debit(175, { memo: 'Constatation #UQ8XDJTR-0001' })],
    [F({ id: 'f7', document_number: 'UQ8XDJTR-0001', company_id: 'c9', company_name: 'Coopérative de solidarité Gaïa' })],
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0].solde, 0)
})
