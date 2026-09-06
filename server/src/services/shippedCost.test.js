// Tests du gel du coût total au moment de l'envoi. Read-only contre la vraie
// DB : on exerce le calcul sur de vraies lignes (une sérialisée, une non
// sérialisée) et l'expression SQL servie aux consommateurs. Aucune écriture —
// freezeShippedTotalCost n'est jamais appelé ici (la DB de dev EST la prod).

import test from 'node:test'
import assert from 'node:assert/strict'

import db from '../db/database.js'
import { computeShippedTotalCost, shippedCostSql, SHIPPED_COST_COLUMN } from './shippedCost.js'

test('ligne inexistante → null', () => {
  assert.equal(computeShippedTotalCost('oi-inexistante-test'), null)
})

test('ligne sérialisée : total = Σ des valeurs de fabrication', () => {
  const row = db.prepare(`
    SELECT oi.id, oi.qty FROM order_items oi
    JOIN serial_numbers sn ON sn.order_item_id = oi.id
    WHERE sn.manufacture_value > 0 AND sn.deleted_at IS NULL
    GROUP BY oi.id
    HAVING COUNT(sn.id) = oi.qty
    LIMIT 1
  `).get()
  if (!row) return // aucune ligne entièrement sérialisée — skip silencieux
  const c = computeShippedTotalCost(row.id)
  const expected = db.prepare(
    'SELECT COALESCE(SUM(manufacture_value), 0) AS t FROM serial_numbers WHERE order_item_id = ? AND deleted_at IS NULL'
  ).get(row.id).t
  assert.equal(c.serial_count, row.qty)
  assert.equal(c.unserialized_qty, 0)
  assert.equal(c.basis, 'series')
  assert.equal(c.total, Math.round(expected * 100) / 100)
})

test('ligne sans numéro de série : total = quantité × coût de la pièce', () => {
  const row = db.prepare(`
    SELECT oi.id, oi.qty, p.unit_cost AS fifo, p.cout_unitaire AS cout_piece
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE CAST(p.cout_unitaire AS REAL) > 0 AND oi.qty > 0
      AND NOT EXISTS (SELECT 1 FROM serial_numbers sn WHERE sn.order_item_id = oi.id)
    LIMIT 1
  `).get()
  if (!row) return
  const c = computeShippedTotalCost(row.id)
  assert.equal(c.serial_count, 0)
  assert.equal(c.basis, 'cout_unitaire')
  assert.equal(c.unserialized_qty, row.qty)
  // Le coût de la pièce prime sur celui saisi sur la ligne de commande.
  assert.equal(c.unit_cost, Number(row.cout_piece))
  assert.equal(c.total, Math.round(row.qty * Number(row.cout_piece) * 100) / 100)
})

test('coût de la pièce : repli sur le coût unitaire FIFO quand « Cout unitaire » est vide', () => {
  const row = db.prepare(`
    SELECT oi.id, p.unit_cost AS fifo FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE p.unit_cost > 0 AND COALESCE(CAST(p.cout_unitaire AS REAL), 0) <= 0
      AND oi.qty > 0
      AND NOT EXISTS (SELECT 1 FROM serial_numbers sn WHERE sn.order_item_id = oi.id)
    LIMIT 1
  `).get()
  if (!row) return
  assert.equal(computeShippedTotalCost(row.id).unit_cost, row.fifo)
})

test('shippedCostSql : coût gelé prioritaire, repli sur la même règle aux coûts du jour', () => {
  const sql = `SELECT ${shippedCostSql('oi')} AS cost FROM order_items oi WHERE oi.id = ?`
  const frozen = db.prepare(
    `SELECT id, ${SHIPPED_COST_COLUMN} AS c FROM order_items
     WHERE ${SHIPPED_COST_COLUMN} IS NOT NULL AND TRIM(${SHIPPED_COST_COLUMN}) != ''
       AND CAST(${SHIPPED_COST_COLUMN} AS REAL) > 0 LIMIT 1`
  ).get()
  if (frozen) {
    assert.equal(db.prepare(sql).get(frozen.id).cost, Number(frozen.c))
  }
  // Une ligne pas encore gelée doit valoir EXACTEMENT ce que le gel écrirait :
  // l'expression SQL et le calcul JS ne peuvent pas diverger.
  const notFrozen = db.prepare(
    `SELECT id FROM order_items
     WHERE (${SHIPPED_COST_COLUMN} IS NULL OR TRIM(${SHIPPED_COST_COLUMN}) = '')
       AND qty > 0 LIMIT 20`
  ).all()
  for (const row of notFrozen) {
    const expected = computeShippedTotalCost(row.id).total
    assert.equal(Math.round(db.prepare(sql).get(row.id).cost * 100) / 100, expected, `ligne ${row.id}`)
  }
})

test("l'import Airtable de la colonne est bien coupé (migration 012)", () => {
  const m = db.prepare(
    'SELECT import_disabled FROM airtable_field_mappings WHERE erp_table = ? AND column_name = ?'
  ).get('order_items', SHIPPED_COST_COLUMN)
  if (!m) return // mapping absent (base neuve) — rien à couper
  assert.equal(m.import_disabled, 1, "le sync Airtable ne doit plus écrire cette colonne")
})
