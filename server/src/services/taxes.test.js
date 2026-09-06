import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeCanadaTaxes, isCanada, resolveInvoiceTaxes, suggestTaxRegime, taxesForRegime } from './taxes.js'

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

describe('Régimes de taxe nommés', () => {
  test('La suggestion suit la province, et vaut le calcul automatique', () => {
    const cases = { QC: 'qc', Ontario: 'hst_on', NS: 'hst_ns', AB: 'gst', SK: 'gst' }
    for (const [province, expected] of Object.entries(cases)) {
      assert.strictEqual(suggestTaxRegime({ province, country: 'Canada' }), expected, province)
      assert.deepStrictEqual(
        taxesForRegime(expected, 100),
        computeCanadaTaxes({ province, country: 'Canada', subtotal: 100 }),
        province,
      )
    }
  })

  test('Hors Canada ou province inconnue → régime « aucune taxe »', () => {
    assert.strictEqual(suggestTaxRegime({ province: 'NY', country: 'USA' }), 'none')
    assert.strictEqual(suggestTaxRegime({ province: 'XYZ', country: 'Canada' }), 'none')
    assert.deepStrictEqual(taxesForRegime('none', 100), [])
  })

  test('Exonération autochtone : régime « none » sur une adresse québécoise', () => {
    // Le choix de l'utilisateur prime sur la province.
    assert.deepStrictEqual(resolveInvoiceTaxes({ province: 'QC', country: 'Canada', subtotal: 100, taxRegime: 'none' }), [])
  })

  test('Régime absent (factures d\'avant le champ) → calcul par province', () => {
    assert.deepStrictEqual(
      resolveInvoiceTaxes({ province: 'QC', country: 'Canada', subtotal: 100, taxRegime: null }),
      computeCanadaTaxes({ province: 'QC', country: 'Canada', subtotal: 100 }),
    )
  })

  test('Un régime choisi ignore la province (TVH ON sur une adresse AB)', () => {
    const r = resolveInvoiceTaxes({ province: 'AB', country: 'Canada', subtotal: 200, taxRegime: 'hst_on' })
    assert.strictEqual(r.length, 1)
    assert.strictEqual(r[0].percentage, 13)
    assert.strictEqual(r[0].amount, 26)
  })

  test('isCanada reconnaît les formes usuelles', () => {
    assert.ok(isCanada('Canada') && isCanada('CA') && isCanada(' canada '))
    assert.ok(!isCanada('USA') && !isCanada(null))
  })
})
