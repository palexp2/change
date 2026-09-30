import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMixedTaxCodeNames, stripTaxableFlags, ZERO_RATED_TAX_CODE_NAME, FULL_TAX_CODE_NAME, GST_ONLY_TAX_CODE_NAME } from './lineTaxCodes.js'

const grocery = () => [
  { description: 'French’s moutarde', total: 2.49, taxable: false },
  { description: 'PC MB lentilles', total: 7.58, taxable: false },
  { description: 'LFLR saucisses', total: 10, taxable: false },
  { description: 'Pains hot-dog', total: 32.25, taxable: false },
  { description: 'Salade Massibec', total: 7.5, taxable: true },
]

test('panier mixte : seule la ligne taxable garde le code taxable', () => {
  const out = applyMixedTaxCodeNames({ items: grocery(), tps: 0.38, tvq: 0.75, other_taxes: 0 })
  assert.equal(out.taxableBase, 7.5)
  assert.deepEqual(out.items.map(it => it.tax_code_name), [
    ZERO_RATED_TAX_CODE_NAME, ZERO_RATED_TAX_CODE_NAME, ZERO_RATED_TAX_CODE_NAME, ZERO_RATED_TAX_CODE_NAME, FULL_TAX_CODE_NAME,
  ])
})

test('document entièrement taxable : rien à poser', () => {
  const items = [{ total: 100, taxable: true }, { total: 50, taxable: true }]
  assert.equal(applyMixedTaxCodeNames({ items, tps: 7.5, tvq: 14.96, other_taxes: 0 }), null)
})

test('marques incohérentes avec les taxes imprimées : on ne code rien', () => {
  const items = grocery().map(it => ({ ...it, taxable: it.total === 10 }))
  assert.equal(applyMixedTaxCodeNames({ items, tps: 0.38, tvq: 0.75, other_taxes: 0 }), null)
})

test('TPS seule : code TPS sur les lignes taxables', () => {
  const items = [{ total: 90, taxable: false }, { total: 10, taxable: true }]
  const out = applyMixedTaxCodeNames({ items, tps: 0.5, tvq: 0, other_taxes: 0 })
  assert.deepEqual(out.items.map(it => it.tax_code_name), [ZERO_RATED_TAX_CODE_NAME, GST_ONLY_TAX_CODE_NAME])
})

test('lignes déjà codées (repas, transport) : intouchées', () => {
  const items = grocery().map(it => ({ ...it, tax_code_id: '15' }))
  assert.equal(applyMixedTaxCodeNames({ items, tps: 0.38, tvq: 0.75, other_taxes: 0 }), null)
})

test('autre taxe au document (TVH, PST) : hors périmètre', () => {
  assert.equal(applyMixedTaxCodeNames({ items: grocery(), tps: 0.38, tvq: 0.75, other_taxes: 2 }), null)
})

test('la marque de taxabilité ne reste pas dans les lignes stockées', () => {
  assert.deepEqual(stripTaxableFlags([{ total: 1, taxable: true }]), [{ total: 1 }])
})
