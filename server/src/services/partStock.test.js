import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePartStock, parseLinkIds, movementChange } from './partStock.js'

const P = (over = {}) => ({ id: 'p1', airtable_id: 'recP1', procurement_type: 'Acheté', besoin_d_un_numero_de_serie: null, inventaire_de_depart: '10', ...over })

test('liens de pièce : JSON ou texte', () => {
  assert.deepEqual(parseLinkIds('["recA","recB"]'), ['recA', 'recB'])
  assert.deepEqual(parseLinkIds('recA, recB'), ['recA', 'recB'])
  assert.deepEqual(parseLinkIds(null), [])
})

test('changement d’un mouvement : valeur / coût sinon qty signée', () => {
  assert.equal(movementChange({ type: 'in', qty: 0, unit_cost: 2, movement_value: 0.6 }), 0.3)
  assert.equal(movementChange({ type: 'adjustment', qty: 4, unit_cost: 1.5, movement_value: -6 }), -4)
  assert.equal(movementChange({ type: 'out', qty: 3, unit_cost: null, movement_value: null }), -3)
  assert.equal(movementChange({ type: 'in', qty: 3, unit_cost: null, movement_value: null }), 3)
})

test('achats : reçu (date, y compris 1970) vs à recevoir', () => {
  const r = computePartStock({ products: [P()], purchases: [
    { nom_de_la_piece: '["recP1"]', quantite_commande: '5.0', cf_date_de_reception_complete: '1970-01-01T00:00:00.000Z' },
    { nom_de_la_piece: 'recP1', quantite_commande: '7', cf_date_de_reception_complete: '2026-10-01' },
    { nom_de_la_piece: 'recP1', quantite_commande: '20', cf_date_de_reception_complete: null },
  ] }).get('p1')
  assert.equal(r.recu, 12)
  assert.equal(r.a_recevoir, 20)
  assert.equal(r.inventaire, 22)
  assert.equal(r.sera_disponible, 42)
})

test('articles : envoyé = dans la boîte ou prélevé ; à envoyer = sans date ni envoi parti', () => {
  const r = computePartStock({ products: [P({ inventaire_de_depart: '100' })], orderItems: [
    { product_id: 'p1', qty: 3, dans_la_boite: '1.0', date_de_l_envoi: '2025-01-01' },
    { product_id: 'p1', qty: 4, dans_la_boite: null, fulfillment_status: "Dans l'envoi", date_de_l_envoi: null, shipped_at: '2026-10-01' },
    { product_id: 'p1', qty: 2, dans_la_boite: null, fulfillment_status: 'Prélevé', date_de_l_envoi: null, shipped_at: null },
    { product_id: 'p1', qty: 6, dans_la_boite: null, fulfillment_status: 'À prélever', date_de_l_envoi: null, shipped_at: null },
  ] }).get('p1')
  assert.equal(r.envoye, 9)
  assert.equal(r.a_envoyer, 8)
  assert.equal(r.inventaire, 91)
  assert.equal(r.sera_disponible, 83)
})

test('mouvements et assemblages', () => {
  const r = computePartStock({ products: [P({ inventaire_de_depart: '0' })],
    movements: [
      { product_id: 'p1', reason: 'Fabrication', type: 'in', qty: 5 },
      { product_id: 'p1', reason: 'Fabrication', type: 'out', qty: 1 },
      { product_id: 'p1', reason: 'Ajustement (augmentation)', type: 'adjustment', qty: 3 },
      { product_id: 'p1', reason: 'Utilisation de pièces usagés', type: 'in', qty: 1 },
      { product_id: 'p1', reason: 'Ajustement (diminution)', type: 'adjustment', qty: 2 },
      { product_id: 'p1', reason: 'Utilisation pour le reconditionnement', type: 'in', qty: 1 },
    ],
    assemblages: [{ product_id: 'p1', qty_produced: 10 }],
  }).get('p1')
  assert.equal(r.utilisees, 4)
  assert.equal(r.ajustements_positifs, 4)
  assert.equal(r.ajustements_negatifs, 3)
  assert.equal(r.fabriques, 10)
  assert.equal(r.inventaire, 7)
})

test('numéro de série : inventaire = séries « Disponible - Vente »', () => {
  const r = computePartStock({ products: [P({ besoin_d_un_numero_de_serie: '1.0' })],
    purchases: [{ nom_de_la_piece: 'recP1', quantite_commande: '50', cf_date_de_reception_complete: '2026-01-01' }],
    serials: [{ product_id: 'p1', status: 'Disponible - Vente' }, { product_id: 'p1', status: 'Disponible - Vente' }, { product_id: 'p1', status: 'Opérationnel - Vendu' }],
  }).get('p1')
  assert.equal(r.inventaire, 2)
})

test('Logiciel / sans type d’approvisionnement : inventaire vide, compté 0', () => {
  const r = computePartStock({ products: [P({ procurement_type: null })],
    orderItems: [{ product_id: 'p1', qty: 2, date_de_l_envoi: null }] }).get('p1')
  assert.equal(r.inventaire, null)
  assert.equal(r.sera_disponible, -2)
})

test('changement exact et assemblage multi-produits', () => {
  const r = computePartStock({ products: [P({ id: 'p1', inventaire_de_depart: '0' }), P({ id: 'p2', airtable_id: 'recP2', inventaire_de_depart: '0' })],
    movements: [{ product_id: 'p1', reason: 'Ajustement (diminution)', type: 'adjustment', qty: 4, qty_change: -4 },
      { product_id: 'p1', reason: 'Fabrication', type: 'in', qty: 0, qty_change: 0.3 }],
    assemblages: [{ product_id: 'p1', product_ids: ['p1', 'p2'], qty_produced: 5 }],
  })
  assert.equal(r.get('p1').ajustements_negatifs, -4)
  assert.equal(r.get('p1').utilisees, 0.3)
  assert.equal(r.get('p2').fabriques, 5)
})
