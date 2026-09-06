// Coût total au moment de l'envoi — gel du coût d'une ligne de commande quand
// elle part dans un envoi.
//
// La règle (reprise de la formule Airtable, désormais tenue par l'ERP) :
//   - chaque numéro de série rattaché à la ligne est valorisé INDIVIDUELLEMENT
//     à sa valeur de fabrication (serial_numbers.manufacture_value) ;
//   - la quantité qui ne porte pas de numéro de série est valorisée au coût de
//     la pièce, lu dans la table Pièces (products) — jamais au coût saisi sur
//     la ligne de commande, qui n'est qu'un report figé au moment de la saisie.
//
// Dégradations assumées, jamais silencieuses (elles sont dans le détail du
// journal de l'automation) : un numéro de série sans valeur de fabrication, ou
// une quantité supérieure au nombre de séries rattachées, est valorisé au coût
// de la pièce pour la part manquante. Mieux vaut un coût approché qu'un coût
// sous-évalué sans le dire.
//
// Pourquoi un service déclenché par l'état de la ligne, et pas une route : un
// envoi naît aussi bien dans Boréal (POST /orders/:id/shipments, PATCH d'une
// ligne, étiquette Novoxpress) que dans Airtable (syncEnvois rattache les
// « items expédiés » à order_items.shipment_id). Le seul point commun aux deux
// origines est l'écriture DB sur la ligne — d'où le watcher change_log
// (services/shippedCostWatcher.js). Le seul chemin d'UI est le recalcul
// explicite d'une commande (refreezeOrderShippedCosts), qui lui écrase.
//
// La colonne `cout_total_au_moment_de_l_envoi` existait déjà, alimentée par le
// champ Airtable du même nom (TEXT, valeurs du style '735.0'). Son import est
// coupé par la migration 012 : l'ERP en est désormais le seul auteur, et les
// valeurs historiques déjà gelées par Airtable restent en place.

import db from '../db/database.js'

export const SHIPPED_COST_COLUMN = 'cout_total_au_moment_de_l_envoi'
export const FROZEN_AT_COLUMN = 'shipped_cost_frozen_at'

// Coût de la pièce, lu dans la table Pièces (products) :
//   1. « Cout unitaire » (products.cout_unitaire) — le coût de référence de la
//      pièce : coût des pièces du BOM pour un produit assemblé, coût unitaire
//      FIFO pour une pièce achetée. C'est la valeur qu'affiche la fiche Pièce,
//      et celle sur laquelle reposent les coûts déjà gelés ;
//   2. à défaut « Coût unitaire (FIFO) » (products.unit_cost) ;
//   3. en dernier recours seulement, le coût porté par la ligne de commande —
//      pour ne pas valoriser à 0 une pièce sans coût de référence.
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function pieceUnitCost(item) {
  if (item.product_id) {
    const p = db.prepare('SELECT unit_cost, cout_unitaire FROM products WHERE id = ?').get(item.product_id)
    const fromPiece = num(p?.cout_unitaire) || num(p?.unit_cost)
    if (fromPiece) return fromPiece
  }
  return num(item.shipped_unit_cost) || num(item.unit_cost)
}

/**
 * Coût total de la ligne au moment présent, selon la règle ci-dessus.
 * Lecture seule — n'écrit rien. Retourne null si la ligne n'existe pas.
 */
export function computeShippedTotalCost(itemId) {
  const item = db.prepare(
    'SELECT id, qty, unit_cost, shipped_unit_cost, product_id FROM order_items WHERE id = ?'
  ).get(itemId)
  if (!item) return null

  const qty = Math.max(Number(item.qty) || 0, 0)
  const unitCost = pieceUnitCost(item)
  // Les numéros de série sont rattachés à la LIGNE (order_item_id), pas à
  // l'envoi — par le scan d'expédition côté Boréal comme par le sync des
  // séries côté Airtable. Ils sont donc déjà là quand l'envoi se crée.
  const serials = db.prepare(
    'SELECT serial, manufacture_value FROM serial_numbers WHERE order_item_id = ? AND deleted_at IS NULL ORDER BY serial'
  ).all(itemId)

  let total = 0
  let valuedSerials = 0
  const serialsWithoutValue = []
  for (const s of serials) {
    const v = Number(s.manufacture_value)
    if (Number.isFinite(v) && v > 0) {
      total += v
      valuedSerials++
    } else {
      total += unitCost
      serialsWithoutValue.push(s.serial || '?')
    }
  }
  // Quantité non couverte par des séries (ligne partiellement sérialisée, ou
  // pièce non sérialisée) : valorisée au coût unitaire.
  const unserializedQty = Math.max(qty - serials.length, 0)
  total += unserializedQty * unitCost

  return {
    item_id: item.id,
    qty,
    unit_cost: unitCost,
    total: Math.round(total * 100) / 100,
    basis: serials.length ? (unserializedQty || serialsWithoutValue.length ? 'mixte' : 'series') : 'cout_unitaire',
    serial_count: serials.length,
    valued_serials: valuedSerials,
    serials_without_value: serialsWithoutValue,
    unserialized_qty: unserializedQty,
  }
}

/**
 * Gèle le coût total de la ligne dans `cout_total_au_moment_de_l_envoi`.
 *
 * N'écrit QUE si la colonne est vide : le gel est définitif par nature (c'est
 * la valeur au moment de l'envoi), et l'historique déjà figé — par Airtable ou
 * par un passage précédent — n'est jamais réécrit. L'UPDATE porte la même
 * condition, donc deux passes concurrentes ne peuvent pas se doubler.
 *
 * `{ force: true }` (recalcul demandé explicitement depuis la fiche commande)
 * lève cette garde : la valeur est recalculée avec les coûts d'aujourd'hui et
 * écrase l'ancienne. Réservé à une action utilisateur — jamais au watcher, qui
 * verrait passer chaque écriture sur la ligne et « dégèlerait » l'historique.
 */
export function freezeShippedTotalCost(itemId, { force = false } = {}) {
  const row = db.prepare(
    `SELECT id, ${SHIPPED_COST_COLUMN} AS current FROM order_items WHERE id = ?`
  ).get(itemId)
  if (!row) return { status: 'missing' }
  const had = row.current != null && String(row.current).trim() !== ''
  if (had && !force) return { status: 'already', current: String(row.current) }
  const c = computeShippedTotalCost(itemId)
  if (!c) return { status: 'missing' }
  const guard = force
    ? ''
    : `AND (${SHIPPED_COST_COLUMN} IS NULL OR TRIM(${SHIPPED_COST_COLUMN}) = '')`
  const r = db.prepare(
    `UPDATE order_items SET ${SHIPPED_COST_COLUMN} = ?, ${FROZEN_AT_COLUMN} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? ${guard}`
  ).run(c.total.toFixed(2), itemId)
  if (!r.changes) return { status: 'already' }
  return { status: 'frozen', previous: had ? Number(row.current) : null, ...c }
}

/**
 * Recalcule et re-gèle toutes les lignes DÉJÀ ENVOYÉES d'une commande, avec les
 * coûts d'aujourd'hui (Pièces + valeurs de fabrication des numéros de série).
 *
 * Le gel automatique ne remplit que les lignes vides ; ce chemin-ci est celui
 * de l'utilisateur qui constate un coût faux (import Airtable historique, coût
 * de pièce corrigé après coup) et demande la reprise du calcul. Les lignes non
 * envoyées ne sont pas touchées : leur coût n'a pas à être figé.
 */
export function refreezeOrderShippedCosts(orderId) {
  const items = db.prepare(
    `SELECT id FROM order_items
     WHERE order_id = ? AND shipment_id IS NOT NULL AND TRIM(shipment_id) != ''
     ORDER BY sort_order, rowid`
  ).all(orderId)
  const results = []
  for (const it of items) {
    const r = freezeShippedTotalCost(it.id, { force: true })
    if (r.status === 'frozen') results.push(r)
  }
  return {
    items: items.length,
    frozen: results.length,
    total: Math.round(results.reduce((s, r) => s + r.total, 0) * 100) / 100,
    details: results,
  }
}

/**
 * Expression SQL du coût d'une ligne de commande, pour les consommateurs
 * (rentabilité d'une commande, dashboards) : le coût gelé à l'envoi quand il
 * existe, sinon le même calcul aux coûts d'aujourd'hui.
 *
 * Le repli n'est pas décoratif : les lignes envoyées avant la mise en place du
 * gel n'ont pas toutes une valeur, et une ligne pas encore expédiée n'en a pas
 * par définition. Il applique la MÊME règle que le gel, pour que le chiffre
 * affiché avant l'envoi soit celui qui sera figé à l'envoi.
 *
 * @param {string} alias alias SQL de la table order_items dans la requête
 */
export function shippedCostSql(alias = 'oi') {
  return `CASE
    WHEN ${frozenShippedCostCondition(alias)} THEN ${frozenShippedCostValue(alias)}
    ELSE ${liveShippedCostSql(alias)}
  END`
}

// Fragments, pour les requêtes qui ont une branche de plus (les statistiques de
// remplacement du dashboard valorisent d'abord les numéros de série encore
// rattachés) : le coût gelé doit y passer AVANT les autres branches.
export function frozenShippedCostCondition(alias = 'oi') {
  return `(${alias}.${SHIPPED_COST_COLUMN} IS NOT NULL
    AND TRIM(${alias}.${SHIPPED_COST_COLUMN}) != ''
    AND CAST(${alias}.${SHIPPED_COST_COLUMN} AS REAL) > 0)`
}

export function frozenShippedCostValue(alias = 'oi') {
  return `CAST(${alias}.${SHIPPED_COST_COLUMN} AS REAL)`
}

// Coût de la pièce (table Pièces), en SQL — même cascade que pieceUnitCost().
export function pieceUnitCostSql(alias = 'oi') {
  const fromPiece = (col) => `NULLIF((SELECT CAST(p.${col} AS REAL) FROM products p WHERE p.id = ${alias}.product_id), 0)`
  return `COALESCE(
    ${fromPiece('cout_unitaire')},
    ${fromPiece('unit_cost')},
    NULLIF(${alias}.shipped_unit_cost, 0),
    NULLIF(${alias}.unit_cost, 0),
    0)`
}

// Le calcul aux coûts d'aujourd'hui, pour une ligne pas encore gelée : chaque
// numéro de série à sa valeur de fabrication, le reste de la quantité au coût
// de la pièce.
export function liveShippedCostSql(alias = 'oi') {
  const piece = pieceUnitCostSql(alias)
  const serials = `SELECT %s FROM serial_numbers sn
      WHERE sn.order_item_id = ${alias}.id AND sn.deleted_at IS NULL`
  const serialValue = serials.replace('%s', `COALESCE(SUM(CASE WHEN sn.manufacture_value > 0 THEN sn.manufacture_value ELSE ${piece} END), 0)`)
  const serialCount = serials.replace('%s', 'COUNT(*)')
  return `(
    (${serialValue})
    + MAX(COALESCE(${alias}.qty, 0) - (${serialCount}), 0) * ${piece}
  )`
}
