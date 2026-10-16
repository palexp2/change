import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDynamicThresholds } from './dynamicThreshold.js'

const prod = (id, over = {}) => ({ id, type: 'Pièce', seuil_min_produits_finis: null, min_stock: 0, ...over })
const run = (products, bom, avail) => computeDynamicThresholds({ products, bom, available: new Map(Object.entries(avail)) })

test('seuil passé par deux produits finis à une pièce partagée', () => {
  const r = run(
    [prod('A', { type: 'Orisha - Core', seuil_min_produits_finis: '10' }), prod('B', { type: 'Orisha - Core', seuil_min_produits_finis: '4' }), prod('c')],
    [{ product_id: 'A', component_id: 'c', qty_required: 2 }, { product_id: 'B', component_id: 'c', qty_required: 1 }],
    { A: 3, B: 4, c: 5 },
  ).get('c')
  assert.equal(r.seuil_min_produits, 24) // 10×2 + 4×1
  assert.equal(r.qte_dans_les_produits, 10) // 3×2 + 4×1
  assert.equal(r.seuil_dynamique, 14)
  assert.equal(r.restant_avant_seuil_dynamique, -9)
  assert.equal(r.quantite_a_commander, 24 * 2 - 5 - 10) // 33
})

test('assez de produits finis : rien à commander, sauf inventaire minimum', () => {
  const products = [prod('A', { seuil_min_produits_finis: 5 }), prod('c', { min_stock: 8 })]
  const bom = [{ product_id: 'A', component_id: 'c', qty_required: 1 }]
  assert.equal(run(products, bom, { A: 10, c: 20 }).get('c').quantite_a_commander, 0)
  // dispo 3 < inventaire minimum 8 → 8×2 − 3
  assert.equal(run(products, bom, { A: 10, c: 3 }).get('c').quantite_a_commander, 13)
})

test('kanban : min = max(0, seuil dynamique), cascade sur ses pièces', () => {
  const products = [
    prod('F', { type: 'Orisha - Core', seuil_min_produits_finis: 10 }),
    prod('K', { type: 'KANBAN', seuil_min_produits_finis: 99 }), // saisie ignorée
    prod('p'),
  ]
  const bom = [{ product_id: 'F', component_id: 'K', qty_required: 1 }, { product_id: 'K', component_id: 'p', qty_required: 3 }]
  let r = run(products, bom, { F: 4, K: 2, p: 0 })
  assert.equal(r.get('K').seuil_dynamique, 6)
  assert.equal(r.get('K').seuil_min_produits_finis, 6)
  assert.equal(r.get('p').seuil_min_produits, 18)
  assert.equal(r.get('p').qte_dans_les_produits, 6)
  assert.equal(r.get('p').seuil_dynamique, 12)
  // trop de produits finis : seuil du kanban négatif → 0, rien ne cascade
  r = run(products, bom, { F: 15, K: 2, p: 0 })
  assert.equal(r.get('K').seuil_dynamique, -5)
  assert.equal(r.get('K').seuil_min_produits_finis, 0)
  assert.equal(r.get('p').seuil_min_produits, 0)
  assert.equal(r.get('p').seuil_dynamique, -6)
})

test('cycle dans la nomenclature : pas de boucle infinie, signalé', () => {
  const products = [prod('K1', { type: 'KANBAN' }), prod('K2', { type: 'KANBAN' }), prod('F', { seuil_min_produits_finis: 2 })]
  const bom = [{ product_id: 'K1', component_id: 'K2', qty_required: 1 }, { product_id: 'K2', component_id: 'K1', qty_required: 1 }, { product_id: 'F', component_id: 'K1', qty_required: 1 }]
  const r = run(products, bom, { K1: 0, K2: 0, F: 0 })
  assert.ok(r.get('K1').cycle || r.get('K2').cycle)
  assert.ok(Number.isFinite(r.get('K1').seuil_dynamique))
})

test('colonnes écrites : pourcentage vide si seuil ≤ 0, seuil min. seulement pour un kanban', async () => {
  const { columnsFor } = await import('./dynamicThresholdWatcher.js')
  const t = { sera_disponible: 5, seuil_dynamique: 10, seuil_min_produits: 24, qte_dans_les_produits: 14, quantite_a_commander: 33.2, seuil_min_produits_finis: 7, stock: { a_recevoir: 3 } }
  const c = columnsFor({ type: 'Connecteur' }, t)
  assert.equal(c.quantite_a_commander, 34)
  assert.equal(c.restant_avant_seuil_dynamique, -5)
  assert.equal(c.pourcentage_restant_seuil_dynamique, -50)
  assert.equal(c.quantite_a_recevoir, 3)
  assert.equal('seuil_min_produits_finis' in c, false)
  assert.equal(columnsFor({ type: 'KANBAN' }, { ...t, seuil_dynamique: 0 }).pourcentage_restant_seuil_dynamique, null)
  assert.equal(columnsFor({ type: 'KANBAN' }, t).seuil_min_produits_finis, 7)
})
