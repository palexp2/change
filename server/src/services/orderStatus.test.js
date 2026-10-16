import test from 'node:test'
import assert from 'node:assert/strict'
import { computeOrderStatus, itemAvailableQty } from './orderStatus.js'

const TODAY = '2026-10-14'
const order = (o = {}) => ({ raison_de_la_mise_en_attente: null, is_subscription: 0, ...o })
// Pièce sans numéro de série, en stock.
const piece = (o = {}) => ({ product_id: 'p', qty: 1, stock_qty: 10, besoin_d_un_numero_de_serie: null, ...o })
const shipped = (o = {}) => piece({ has_shipment: true, shipped_at: '2026-10-01', ...o })

test('aucune ligne → Commande vide', () => {
  assert.equal(computeOrderStatus(order(), [], TODAY), 'Commande vide')
})

test('tout envoyé → Envoyé, ou Envoyé aujourd’hui', () => {
  assert.equal(computeOrderStatus(order(), [shipped()], TODAY), 'Envoyé')
  assert.equal(computeOrderStatus(order(), [shipped({ shipped_at: TODAY })], TODAY), "Envoyé aujourd'hui")
})

test('ligne rattachée à un envoi pas encore parti → Envoyé ; datée du jour → Envoyé aujourd’hui', () => {
  assert.equal(computeOrderStatus(order(), [shipped({ shipped_at: '' })], TODAY), 'Envoyé')
  assert.equal(computeOrderStatus(order(), [shipped({ shipped_at: TODAY })], TODAY), "Envoyé aujourd'hui")
})

test('une ligne rattachée + une non rattachée en stock → Partiellement envoyé', () => {
  assert.equal(computeOrderStatus(order(), [shipped({ shipped_at: '' }), piece()], TODAY), 'Partiellement envoyé')
})

test('ligne prélevée non rattachée → Tout est dans la boite', () => {
  assert.equal(computeOrderStatus(order(), [piece({ fulfillment_status: 'Prélevé' })], TODAY), 'Tout est dans la boite')
})

test('lignes négatives : s’annulent avec le restant', () => {
  assert.equal(computeOrderStatus(order(), [piece({ qty: 20 }), piece({ qty: -20 })], TODAY), 'Envoyé')
})

test('rien envoyé mais une pièce indisponible → à fabriquer (le bogue de la formule Airtable)', () => {
  const items = [piece({ qty: 5, stock_qty: 5 }), piece({ qty: 5, besoin_d_un_numero_de_serie: '1.0', serials_sale: 0 })]
  assert.equal(computeOrderStatus(order(), items, TODAY), 'Items à fabriquer ou à acheter')
})

test('logiciel ignoré pour la disponibilité ; tout dispo → Tous les items sont disponibles', () => {
  const items = [piece(), piece({ product_type: 'JWT', stock_qty: 0 })]
  assert.equal(computeOrderStatus(order(), items, TODAY), 'Tous les items sont disponibles')
})

test('ne restent que des logiciels → JWT-config ; que du drop ship → Drop ship seulement', () => {
  assert.equal(computeOrderStatus(order(), [shipped(), piece({ product_type: 'JWT' })], TODAY), 'JWT-config')
  assert.equal(computeOrderStatus(order(), [piece({ procurement_type: 'Drop ship', stock_qty: 0 })], TODAY), 'Drop ship seulement')
})

test('mise en attente et gel passent avant la disponibilité', () => {
  assert.equal(computeOrderStatus(order({ raison_de_la_mise_en_attente: 'client' }), [piece({ stock_qty: 0 })], TODAY), 'En attente')
  assert.equal(computeOrderStatus(order(), [piece({ gel_d_envois: '1.0' })], TODAY), "Gel d'envois")
})

test('restant prélevé → Tout est dans la boite ; une partie envoyée → Partiellement envoyé', () => {
  assert.equal(computeOrderStatus(order(), [piece({ fulfillment_status: 'Prélevé', stock_qty: 0 })], TODAY), 'Tout est dans la boite')
  assert.equal(computeOrderStatus(order(), [shipped(), piece()], TODAY), 'Partiellement envoyé')
})

test('séries : quantité exacte suffit ; location comptée pour un abonnement ou un remplacement', () => {
  const it = piece({ qty: 2, besoin_d_un_numero_de_serie: '1.0', serials_sale: 1, serials_rental: 1 })
  assert.equal(itemAvailableQty(it, false), 1)
  assert.equal(itemAvailableQty(it, true), 2)
  assert.equal(itemAvailableQty({ ...it, item_type: 'Remplacement' }, false), 2)
  assert.equal(computeOrderStatus(order({ is_subscription: 1 }), [it], TODAY), 'Tous les items sont disponibles')
})
