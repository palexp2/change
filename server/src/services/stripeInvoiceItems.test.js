import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLine } from './stripeInvoiceItems.js'

// Régression : facture e4b05465 / in_1TZkFrEO122sMsbJuyG2KW9B affichait
// "Prix unit. 83,80 $" alors que c'était le TTC. Le prix Stripe a
// `tax_behavior: "inclusive"`, donc `line.amount` et `pricing.unit_amount_decimal`
// sont TTC. La base HT correcte est `line.subtotal` (7289 cents = 72,89 $).
describe('normalizeLine — tax_behavior inclusive', () => {
  test('utilise line.subtotal (HT) plutôt que line.amount (TTC) pour unit_amount/amount', () => {
    const line = {
      id: 'il_1TZkFrEO122sMsbJQj62Vrtl',
      object: 'line_item',
      amount: 8380,           // TTC
      subtotal: 7289,         // HT — base imposable
      currency: 'cad',
      description: '1 × Location (at $83.80 / month)',
      quantity: 1,
      pricing: {
        price_details: {
          price: 'price_1Q8S6dEO122sMsbJ0AXzNpQc',
          product: 'prod_R0T26atyjYEdDS',
        },
        unit_amount_decimal: '8380', // TTC, à ignorer
      },
      taxes: [
        { amount: 364, tax_behavior: 'inclusive', taxable_amount: 7289 },
        { amount: 727, tax_behavior: 'inclusive', taxable_amount: 7289 },
      ],
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.unit_amount, 7289, 'unit_amount doit être HT')
    assert.strictEqual(n.amount, 7289, 'amount doit être HT')
    assert.strictEqual(n.quantity, 1)
    assert.strictEqual(n.stripe_price_id, 'price_1Q8S6dEO122sMsbJ0AXzNpQc')
    assert.strictEqual(n.stripe_product_id, 'prod_R0T26atyjYEdDS')
    assert.strictEqual(n.currency, 'CAD')
  })

  test('quantity > 1 : unit_amount = subtotal / quantity', () => {
    const line = {
      id: 'il_qty3',
      amount: 25140,      // TTC (3 × 8380)
      subtotal: 21867,    // HT (3 × 7289)
      quantity: 3,
      currency: 'cad',
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.unit_amount, 7289)
    assert.strictEqual(n.amount, 21867)
  })
})

describe('normalizeLine — tax_behavior exclusive (cas classique)', () => {
  test('line.amount == line.subtotal == HT', () => {
    const line = {
      id: 'il_excl',
      amount: 10000,
      subtotal: 10000,
      quantity: 1,
      currency: 'cad',
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.unit_amount, 10000)
    assert.strictEqual(n.amount, 10000)
  })
})

describe('normalizeLine — proration', () => {
  test('utilise le prorata réel (subtotal / quantity), pas le tarif mensuel plein', () => {
    // Demi-mois : ligne facturée 36,45 $ HT au lieu de 72,89 $/mois plein.
    const line = {
      id: 'il_prorate',
      amount: 4190,        // TTC prorata
      subtotal: 3645,      // HT prorata
      quantity: 1,
      proration: true,
      currency: 'cad',
      pricing: {
        price_details: { price: 'price_xxx', product: 'prod_xxx' },
        unit_amount_decimal: '8380', // tarif plein TTC — à ignorer
      },
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.unit_amount, 3645, 'unit doit refléter le prorata, pas le tarif plein')
    assert.strictEqual(n.amount, 3645)
    assert.strictEqual(n.proration, 1)
  })
})

describe('normalizeLine — fallback ancienne API (line.price object)', () => {
  test('extrait price.id, price.product et unit_amount via line.price si pas de pricing', () => {
    const line = {
      id: 'il_legacy',
      amount: 5000,
      subtotal: 5000,
      quantity: 1,
      currency: 'cad',
      price: {
        id: 'price_legacy',
        product: 'prod_legacy',
        unit_amount: 5000,
        currency: 'cad',
      },
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.stripe_price_id, 'price_legacy')
    assert.strictEqual(n.stripe_product_id, 'prod_legacy')
    assert.strictEqual(n.unit_amount, 5000)
    assert.strictEqual(n.amount, 5000)
  })

  test('sans subtotal (très vieille API), fallback sur line.amount', () => {
    const line = {
      id: 'il_no_subtotal',
      amount: 5000,
      quantity: 1,
      currency: 'cad',
    }
    const n = normalizeLine('in_xxx', 0, line)
    assert.strictEqual(n.unit_amount, 5000)
    assert.strictEqual(n.amount, 5000)
  })
})

describe('normalizeLine — divers', () => {
  test('synthetic id quand line.id manque', () => {
    const n = normalizeLine('in_xxx', 7, { amount: 100, description: 'x', currency: 'cad' })
    assert.match(n.stripe_line_id, /^adhoc_[a-f0-9]{16}$/)
  })

  test('quantity manquante → défaut 1', () => {
    const n = normalizeLine('in_xxx', 0, { id: 'il_x', amount: 100, subtotal: 100 })
    assert.strictEqual(n.quantity, 1)
    assert.strictEqual(n.unit_amount, 100)
  })

  test('periods convertis en ISO', () => {
    const n = normalizeLine('in_xxx', 0, {
      id: 'il_p',
      amount: 100,
      subtotal: 100,
      period: { start: 1779422400, end: 1782100800 },
    })
    assert.strictEqual(n.period_start, '2026-05-22T04:00:00.000Z')
    assert.strictEqual(n.period_end, '2026-06-22T04:00:00.000Z')
  })
})
