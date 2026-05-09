import test from 'node:test'
import assert from 'node:assert/strict'

import { computeMonthlyNet } from './subscriptionMonthly.js'

const itemMonthly = (cents, qty = 1) => ({
  price: { unit_amount: cents, currency: 'cad', recurring: { interval: 'month', interval_count: 1 } },
  quantity: qty,
})
const itemYearly = (cents, qty = 1) => ({
  price: { unit_amount: cents, currency: 'cad', recurring: { interval: 'year', interval_count: 1 } },
  quantity: qty,
})

test('préfère latest_invoice.total_excluding_tax (montant net, hors taxes)', () => {
  // Cabru-style : item à 40 $/mois, taxes 14,975 % → invoice.total = 45,99
  // total_excluding_tax = 4000 cents → 40 $/mois
  const sub = {
    items: { data: [itemMonthly(4000)] },
    latest_invoice: { total_excluding_tax: 4000, total: 4599 },
  }
  const { amountMonthly, currency, intervalType } = computeMonthlyNet(sub)
  assert.equal(amountMonthly, 40)
  assert.equal(currency, 'CAD')
  assert.equal(intervalType, 'month')
})

test('subtotal_excluding_tax sert de fallback à total_excluding_tax', () => {
  const sub = {
    items: { data: [itemMonthly(4000)] },
    latest_invoice: { subtotal_excluding_tax: 3500 }, // remise invoice de 5 $
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 35)
})

test('sub annuel : montant cycle invoice ÷ 12', () => {
  // 1200 $/an avant taxes → 100 $/mois
  const sub = {
    items: { data: [itemYearly(120000)] },
    latest_invoice: { total_excluding_tax: 120000 },
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 100)
})

test('fallback items sans rabais', () => {
  // Pas de latest_invoice expandé (string ID) → somme items
  const sub = {
    items: { data: [itemMonthly(4000), itemMonthly(2000, 2)] },
    latest_invoice: 'in_xxx',
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 80) // 40 + 40
})

test('fallback items avec rabais percent_off', () => {
  const sub = {
    items: { data: [itemMonthly(4000)] },
    discounts: [{ coupon: { percent_off: 10 } }],
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 36)
})

test('fallback items avec rabais amount_off (par cycle)', () => {
  // 80 $/mois - 5 $/cycle = 75 $/mois
  const sub = {
    items: { data: [itemMonthly(4000, 2)] },
    discounts: [{ coupon: { amount_off: 500 } }],
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 75)
})

test('fallback annuel avec amount_off : amount_off est par cycle (an), pas par mois', () => {
  // 1200 $/an - 60 $/an = 1140 $/an = 95 $/mois
  const sub = {
    items: { data: [itemYearly(120000)] },
    discounts: [{ coupon: { amount_off: 6000 } }],
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 95)
})

test('rabais via sub.discounts[].source.coupon (Stripe API ≥ 2024)', () => {
  const sub = {
    items: { data: [itemMonthly(4000)] },
    discounts: [{ source: { coupon: { percent_off: 25 } } }],
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 30)
})

test('legacy sub.discount (singulier, avant 2024) supporté', () => {
  const sub = {
    items: { data: [itemMonthly(4000)] },
    discount: { coupon: { percent_off: 50 } },
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 20)
})

test('plancher à 0 : rabais > items', () => {
  const sub = {
    items: { data: [itemMonthly(1000)] },
    discounts: [{ coupon: { amount_off: 5000 } }],
  }
  assert.equal(computeMonthlyNet(sub).amountMonthly, 0)
})

test('sub vide : retourne 0', () => {
  assert.equal(computeMonthlyNet({}).amountMonthly, 0)
  assert.equal(computeMonthlyNet({ items: { data: [] } }).amountMonthly, 0)
})
