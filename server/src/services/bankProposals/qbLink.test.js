import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickQbProposals, parseAutoMethods, confidenceOf } from './qbLink.js'

const entry = (id) => ({ qbId: id, entity: 'expense', label: 'Hydro-Québec', date: '2026-09-02' })
const account = { id: 'acc1', currency: 'CAD' }

describe('pickQbProposals', () => {
  test('un montant et une date exacts se posent sans demander', () => {
    const m = new Map([['t1', { method: 'exact', delta: 0, gap: 0, entries: [entry('4182')] }]])
    const { auto, proposals } = pickQbProposals(m, { account })
    assert.equal(auto.size, 1)
    assert.equal(proposals.length, 0)
  })

  test('une tolérance est proposée, jamais posée', () => {
    const m = new Map([['t1', { method: 'tolerance', delta: -0.5, gap: 2, entries: [entry('4182')] }]])
    const { auto, proposals } = pickQbProposals(m, { account })
    assert.equal(auto.size, 0)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0].kind, 'qb_link')
    assert.equal(proposals[0].payload.qb_txn_id, '4182')
    assert.ok(proposals[0].evidence.some((e) => e.label === 'Écart de montant'))
  })

  test('une conversion NON vérifiée est proposée', () => {
    const m = new Map([['t1', { method: 'conversion', verified: false, entries: [entry('99')] }]])
    assert.equal(pickQbProposals(m, { account }).proposals.length, 1)
  })

  test('une conversion vérifiée se pose', () => {
    const m = new Map([['t1', { method: 'conversion', verified: true, rate: 1.3842, entries: [entry('99')] }]])
    assert.equal(pickQbProposals(m, { account }).auto.size, 1)
  })

  test('une ligne pas encore importée n’est ni posée ni proposée', () => {
    const m = new Map([['à-importer-0', { method: 'tolerance', entries: [entry('1')] }]])
    const { auto, proposals } = pickQbProposals(m, { account })
    assert.equal(auto.size, 0)
    assert.equal(proposals.length, 0)
  })

  test('une ligne déjà liée à la MÊME écriture ne repropose rien', () => {
    const m = new Map([['t1', { method: 'tolerance', entries: [entry('4182')] }]])
    const txnById = new Map([['t1', { id: 't1', qb_txn_id: '4182', qb_match_method: 'fenetre' }]])
    assert.equal(pickQbProposals(m, { account, txnById }).proposals.length, 0)
  })

  test('un lien posé ou confirmé par un humain n’est jamais écrasé', () => {
    const m = new Map([['t1', { method: 'tolerance', entries: [entry('9999')] }]])
    for (const method of ['manuel', 'proposition', 'erp']) {
      const txnById = new Map([['t1', { id: 't1', qb_txn_id: '4182', qb_match_method: method }]])
      assert.equal(pickQbProposals(m, { account, txnById }).proposals.length, 0, method)
    }
    // Un lien posé automatiquement, lui, peut être remis en question.
    const auto = new Map([['t1', { id: 't1', qb_txn_id: '4182', qb_match_method: 'fenetre' }]])
    assert.equal(pickQbProposals(m, { account, txnById: auto }).proposals.length, 1)
  })

  test('liste blanche vide = tout est proposé', () => {
    const m = new Map([['t1', { method: 'exact', entries: [entry('4182')] }]])
    const { auto, proposals } = pickQbProposals(m, { account, autoMethods: [] })
    assert.equal(auto.size, 0)
    assert.equal(proposals.length, 1)
  })

  test('l’empreinte tient à la cible, pas à la confiance', () => {
    const mk = (delta) => pickQbProposals(
      new Map([['t1', { method: 'tolerance', delta, gap: 1, entries: [entry('4182')] }]]),
      { account }
    ).proposals[0].fingerprint
    assert.equal(mk(-0.5), mk(-2.5))
  })
})

describe('parseAutoMethods', () => {
  test('lit la configuration de l’automation', () => {
    assert.deepEqual(parseAutoMethods('exact, conversion'), ['exact', 'conversion'])
    assert.deepEqual(parseAutoMethods(''), [])
    assert.deepEqual(parseAutoMethods(null), ['exact', 'conversion'])
  })
})

describe('confidenceOf', () => {
  test('classe les méthodes dans le bon ordre', () => {
    assert.ok(confidenceOf({ method: 'exact' }) > confidenceOf({ method: 'fenetre' }))
    assert.ok(confidenceOf({ method: 'fenetre' }) > confidenceOf({ method: 'tolerance' }))
  })
  test('un écart de date coûte de la confiance', () => {
    assert.ok(confidenceOf({ method: 'fenetre', gap: 10 }) < confidenceOf({ method: 'fenetre', gap: 0 }))
  })
})
