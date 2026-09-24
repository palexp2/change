import test from 'node:test'
import assert from 'node:assert/strict'
import { consolidateSingleItemCharges, extractChargeLines } from './saleReceiptSingleItem.js'
import { reconcileDiscountFreightProrata } from './saleReceiptExtraction.js'
import { buildReceiptLines } from './quickbooks.js'

const article = { description: 'LIA-2016\tRainbird - Valve 24V 1 Pouce', total: 883.2, purchase_id: 'purchase-2016', lia_ref: 'LIA-2016', source_description: 'RB.VALVE ELECTRIQUE' }
const freight = { description: 'Frais de transport', total: 20.81 }

test('Dubois 602193 : une ligne de stock à 904,01 $, référence et source conservées', () => {
  const items = [article, freight]
  const out = consolidateSingleItemCharges(items)
  assert.deepEqual(out, [{ ...article, total: 904.01, quantity: null, unit_price: null }])
  assert.equal(items[0].total, 883.2)
  const lines = buildReceiptLines(items, 904.01, { lineDetail: { AccountRef: { value: '71' }, TaxCodeRef: { value: '8' } } })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Amount, 904.01)
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '71')
  assert.equal(lines[0].AccountBasedExpenseLineDetail.TaxCodeRef.value, '8')
})

test('article sans LIA : transport et escompte signés inclus une seule fois', () => {
  const out = consolidateSingleItemCharges([
    { description: 'Valve', quantity: 25, unit_price: 35.328 }, freight,
    { description: 'Escompte 10 %', total: -88.32 },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].total, 815.69)
  assert.deepEqual(consolidateSingleItemCharges(out), out)
})

test('plusieurs articles ou transport vendu comme article : aucune fusion', () => {
  for (const items of [
    [article, { description: 'Câble', total: 20 }, freight],
    [article, { description: 'Caisse de transport', total: 20 }],
    [article, { ...freight, purchase_id: 'transport-product' }],
  ]) assert.equal(consolidateSingleItemCharges(items), items)
})

test('taxes ou comptes différents : ventilation explicite conservée', () => {
  for (const override of [{ tax_code_id: '__none__' }, { expense_account_id: '70' }]) {
    const items = [article, { ...freight, ...override }]
    assert.equal(consolidateSingleItemCharges(items), items)
  }
})

test('Provo INV375790 : « Coût d\'expédition » sorti des lignes et réparti au prorata', () => {
  const items = [
    { description: '7182-300 18-2c BC UNSH', quantity: 300, unit_price: 0.8, total: 240 },
    { description: '9224-150 22-4c UNSH CSA FT4', quantity: 150, unit_price: 0.9, total: 135 },
    { description: "Coût d'expédition", quantity: 1, unit_price: 28.38, total: 28.38 },
  ]
  const charges = extractChargeLines(items)
  assert.equal(charges.freight, 28.38)
  assert.equal(charges.discount, 0)
  const out = reconcileDiscountFreightProrata(charges.articles, { freight: charges.freight, htBase: 403.38 })
  assert.deepEqual(out.items.map(it => it.total), [258.16, 145.22])
  assert.equal(out.subtotal, 403.38)
})

test('rien à sortir : un seul article, aucune ligne de frais, ou ventilation distincte', () => {
  const a = { description: 'Câble A', total: 240 }
  const b = { description: 'Câble B', total: 135 }
  const frais = { description: "Coût d'expédition", total: 28.38 }
  assert.equal(extractChargeLines([a, frais]), null)
  assert.equal(extractChargeLines([a, b]), null)
  assert.equal(extractChargeLines([a, b, { ...frais, tax_code_id: '__none__' }]), null)
  assert.equal(extractChargeLines([a, b, { ...frais, purchase_id: 'p1' }]), null)
})
