// Coût unitaire des pièces FABRIQUÉES — tenu par Boréal (2026-10-14), à partir
// de la nomenclature locale (bom_items, miroir de la table Airtable « BOM »).
//
// Avant : formule Airtable « Cout unitaire » de la pièce, importée dans
// products.cout_unitaire. Pierre-Alexandre Papillon débranche Airtable pour ça.
//
// La règle Airtable, relue le 2026-10-14 (API meta, table Pièces) :
//   Cout unitaire  = IF(Type de procurement = "Fabriqué", Coût des pièces, Coût unitaire (FIFO))
//   Coût des pièces = SUM(BOM « QTY nécessaire x Coût nuitaire »)
//   ligne BOM       = QTY nécessaires × « Coût unitaire (FIFO) » du composant
// Ni main-d'œuvre, ni frais, ni arrondi (précision 2 = affichage seulement).
//
// Écart voulu : Airtable lisait le FIFO du composant même quand celui-ci est un
// sous-assemblage fabriqué (valeur jamais tenue pour lui). Ici un composant
// fabriqué qui a sa propre nomenclature est valorisé récursivement à son coût
// de nomenclature. Comme ce coût est désormais poussé dans son « Coût unitaire
// (FIFO) » Airtable, les deux calculs retombent d'accord.
//
// Coût d'un composant acheté : products.cout_unitaire, à défaut unit_cost
// (même ordre que services/shippedCost.js). Les deux sont égaux pour une pièce
// achetée, Boréal les tient ensemble (services/fifoCost.js).
// Alertes (comptées à 0 $, comme le faisait Airtable) : composant sans coût,
// nomenclature circulaire. Une pièce sans aucune ligne de nomenclature n'a pas
// de coût calculé : le coût en place n'est pas touché.
// Composant accepté sans coût pour ce produit (bom_free_components, 2026-10-15) :
// 0 $ sans alerte tant qu'il n'a pas de coût — s'il en reçoit un, il compte.

import db from '../db/database.js'

function freeComponents(productId) {
  return new Set(db.prepare('SELECT component_id FROM bom_free_components WHERE product_id = ?')
    .all(productId).map(r => r.component_id))
}

function positive(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function bomLines(productId) {
  return db.prepare(`
    SELECT b.id AS bom_id, b.component_id, b.qty_required, c.id AS found, c.sku, c.name_fr,
           c.procurement_type, c.cout_unitaire, c.unit_cost
    FROM bom_items b LEFT JOIN products c ON c.id = b.component_id
    WHERE b.product_id = ?
    ORDER BY c.sku, b.id
  `).all(productId)
}

/**
 * Coût de nomenclature d'une pièce. Lecture seule.
 * @returns {{ cost: number|null, lines: object[], issues: object[] }}
 *   cost null = aucune ligne de nomenclature.
 */
export function computeBomCost(productId, memo = new Map(), stack = new Set()) {
  if (memo.has(productId)) return memo.get(productId)
  const rows = bomLines(productId)
  if (!rows.length) {
    const empty = { cost: null, lines: [], issues: [] }
    memo.set(productId, empty)
    return empty
  }
  stack.add(productId)
  const free = freeComponents(productId)
  const issues = []
  const lines = []
  let total = 0
  for (const r of rows) {
    const qty = Number(r.qty_required) || 0
    let unit = null
    let flag = null
    let accepted = false
    if (!r.found) {
      flag = 'sans_cout'
    } else if (r.procurement_type === 'Logiciel') {
      unit = 0
    } else if (r.procurement_type === 'Fabriqué' && stack.has(r.component_id)) {
      flag = 'cycle'
    } else {
      const sub = r.procurement_type === 'Fabriqué' ? computeBomCost(r.component_id, memo, stack) : null
      if (sub?.issues.some(i => i.kind === 'cycle')) flag = 'cycle'
      unit = sub?.cost ?? positive(r.cout_unitaire) ?? positive(r.unit_cost)
      if (unit == null && !flag) flag = 'sans_cout'
    }
    if (flag === 'sans_cout' && free.has(r.component_id)) { unit = 0; flag = null; accepted = true }
    if (flag) issues.push({ kind: flag, bom_id: r.bom_id, component_id: r.component_id, sku: r.sku, qty })
    if (unit != null) total += qty * unit
    lines.push({ bom_id: r.bom_id, component_id: r.component_id, sku: r.sku, name: r.name_fr, qty, unit_cost: unit, flag, free: accepted })
  }
  stack.delete(productId)
  const res = { cost: Math.round(total * 10000) / 10000, lines, issues }
  // Un résultat atteint par un cycle dépend de l'ordre de visite : pas mémorisé.
  if (!issues.some(i => i.kind === 'cycle')) memo.set(productId, res)
  return res
}

/**
 * Pièces fabriquées qui utilisent (directement ou via un sous-assemblage)
 * l'une des pièces données. Un parent acheté garde son coût FIFO : on ne
 * remonte qu'à travers les fabriquées.
 */
export function fabricatedAncestors(productIds) {
  const stmt = db.prepare(`
    SELECT DISTINCT b.product_id FROM bom_items b JOIN products p ON p.id = b.product_id
    WHERE b.component_id = ? AND p.procurement_type = 'Fabriqué' AND p.deleted_at IS NULL
  `)
  const seen = new Set()
  const queue = [...productIds]
  while (queue.length) {
    const id = queue.shift()
    for (const { product_id } of stmt.all(id)) {
      if (seen.has(product_id)) continue
      seen.add(product_id)
      queue.push(product_id)
    }
  }
  return [...seen]
}

/**
 * Ordre de recalcul : achetées d'abord, puis fabriquées des niveaux bas vers
 * les hauts (un sous-assemblage avant le produit qui l'utilise).
 */
export function orderForRecompute(productIds) {
  const typeOf = db.prepare('SELECT procurement_type FROM products WHERE id = ?')
  const subs = db.prepare(`
    SELECT DISTINCT b.component_id FROM bom_items b JOIN products c ON c.id = b.component_id
    WHERE b.product_id = ? AND c.procurement_type = 'Fabriqué'
  `)
  const depth = new Map()
  const level = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    let d = 1
    for (const { component_id } of subs.all(id)) d = Math.max(d, level(component_id, stack) + 1)
    stack.delete(id)
    depth.set(id, d)
    return d
  }
  return [...new Set(productIds)]
    .map(id => ({ id, d: typeOf.get(id)?.procurement_type === 'Fabriqué' ? level(id) : 0 }))
    .sort((a, b) => a.d - b.d)
    .map(x => x.id)
}
