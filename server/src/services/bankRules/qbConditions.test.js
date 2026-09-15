// Décoder les conditions telles que QuickBooks les exporte réellement —
// structures relevées dans l'export de Charles du 2026-09-12.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeQbConditions, extractJsonBlob } from './qbConditions.js'

const blob = (o) => JSON.stringify(o)

describe('decodeQbConditions', () => {
  it('lit un ET avec un seuil de montant signé', () => {
    const d = decodeQbConditions(blob({
      ruleConditions: [
        { ruleType: 10, value: '-1' },
        { ruleType: 3, value: '-1000.00' },
        { ruleType: 1, value: 'MISCELLANEOUS ACC.' },
      ],
      isAndRule: true,
    }))
    assert.equal(d.direction, 'sortie')
    assert.equal(d.mode, 'all')
    assert.deepEqual(d.terms, [
      { field: 'amount', op: 'lt', value: -1000 },
      { field: 'label', op: 'contains', value: 'MISCELLANEOUS ACC.' },
    ])
    assert.deepEqual(d.unknown, [])
  })

  it('distingue deux règles sur le même libellé par leur seuil', () => {
    const salaires = decodeQbConditions(blob({ ruleConditions: [{ ruleType: 3, value: '-1000.00' }, { ruleType: 1, value: 'MISCELLANEOUS ACC.' }], isAndRule: true }))
    const nethris = decodeQbConditions(blob({ ruleConditions: [{ ruleType: 4, value: '-300.00' }, { ruleType: 1, value: 'MISCELLANEOUS ACC.' }], isAndRule: true }))
    assert.equal(salaires.terms[0].op, 'lt')
    assert.equal(nethris.terms[0].op, 'gt')
  })

  it('lit un OU et un sens « argent qui entre »', () => {
    const d = decodeQbConditions(blob({
      ruleConditions: [{ ruleType: 10, value: '1' }, { ruleType: 1, value: 'INTEREST' }, { ruleType: 1, value: 'INTERET' }],
      isAndRule: false,
    }))
    assert.equal(d.direction, 'entree')
    assert.equal(d.mode, 'any')
    assert.equal(d.terms.length, 2)
    assert.equal(d.summary, '« INTEREST » ou « INTERET »')
  })

  it('signale un type inconnu plutôt que de l\'inventer', () => {
    const d = decodeQbConditions(blob({ ruleConditions: [{ ruleType: 1, value: 'X' }, { ruleType: 99, value: 'Y' }], isAndRule: true }))
    assert.equal(d.terms.length, 1)
    assert.match(d.unknown[0], /99/)
  })

  it('rassemble la structure éclatée sur plusieurs cellules du tableur', () => {
    const parts = ['Frais BNC', '{"ruleConditions":[{"ruleType":1', '"value":"FRAIS FORFAIT"}]', '"isAndRule":false}', 'Frais bancaires']
    const text = extractJsonBlob(parts)
    assert.ok(text.startsWith('{"ruleConditions"'))
    const d = decodeQbConditions(text)
    assert.equal(d.terms[0].value, 'FRAIS FORFAIT')
  })

  it('ne rend rien sur autre chose que cette structure', () => {
    assert.equal(decodeQbConditions('La description contient NOVO'), null)
    assert.equal(decodeQbConditions(''), null)
  })
})
