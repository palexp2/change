import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeCanadaTaxes } from './taxes.js'

describe('computeCanadaTaxes', () => {
  test('Hors Canada → 0 taxe', () => {
    assert.deepStrictEqual(computeCanadaTaxes({ province: 'CA', country: 'USA', subtotal: 100 }), [])
    assert.deepStrictEqual(computeCanadaTaxes({ province: null, country: 'France', subtotal: 100 }), [])
  })

  test('Canada sans province → 0 taxe', () => {
    assert.deepStrictEqual(computeCanadaTaxes({ province: null, country: 'Canada', subtotal: 100 }), [])
  })

  test('QC → TPS 5% + TVQ 9.975%', () => {
    const r = computeCanadaTaxes({ province: 'QC', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r.length, 2)
    assert.strictEqual(r[0].name, 'TPS')
    assert.strictEqual(r[0].percentage, 5)
    assert.strictEqual(r[0].amount, 5)
    assert.strictEqual(r[1].name, 'TVQ')
    assert.strictEqual(r[1].percentage, 9.975)
    assert.strictEqual(r[1].amount, 9.98) // arrondi 2 décimales
  })

  test('ON → HST 13%', () => {
    const r = computeCanadaTaxes({ province: 'ON', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r.length, 1)
    assert.strictEqual(r[0].name, 'HST')
    assert.strictEqual(r[0].percentage, 13)
    assert.strictEqual(r[0].amount, 13)
  })

  test('NB/NL/NS/PE → HST 15%', () => {
    for (const p of ['NB', 'NL', 'NS', 'PE']) {
      const r = computeCanadaTaxes({ province: p, country: 'Canada', subtotal: 200 })
      assert.strictEqual(r.length, 1, `province ${p}`)
      assert.strictEqual(r[0].percentage, 15, `province ${p}`)
      assert.strictEqual(r[0].amount, 30, `province ${p}`)
    }
  })

  test('SK → TPS 5% seulement (Orisha pas inscrit en SK)', () => {
    const r = computeCanadaTaxes({ province: 'SK', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r.length, 1)
    assert.strictEqual(r[0].name, 'TPS')
    assert.strictEqual(r[0].percentage, 5)
  })

  test('BC → TPS 5% seulement (Orisha pas inscrit en BC)', () => {
    const r = computeCanadaTaxes({ province: 'BC', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r.length, 1)
    assert.strictEqual(r[0].name, 'TPS')
    assert.strictEqual(r[0].percentage, 5)
  })

  test('AB / MB / YT / NT / NU → TPS 5% seulement (provinces sans taxe provinciale)', () => {
    for (const p of ['AB', 'MB', 'YT', 'NT', 'NU']) {
      const r = computeCanadaTaxes({ province: p, country: 'Canada', subtotal: 100 })
      assert.strictEqual(r.length, 1, `province ${p}`)
      assert.strictEqual(r[0].percentage, 5, `province ${p}`)
    }
  })

  test('Noms de provinces longs reconnus', () => {
    const r1 = computeCanadaTaxes({ province: 'Québec', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r1.length, 2)
    const r2 = computeCanadaTaxes({ province: 'Ontario', country: 'Canada', subtotal: 100 })
    assert.strictEqual(r2[0].name, 'HST')
  })

  test('Province inconnue dans Canada → 0 taxe (refus implicite)', () => {
    assert.deepStrictEqual(computeCanadaTaxes({ province: 'XYZ', country: 'Canada', subtotal: 100 }), [])
  })
})
