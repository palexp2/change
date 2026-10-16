// Ce que les miroirs Airtable perdent et dont l'inventaire des pièces a besoin
// (services/partStock.js). Appelé par le finalize des miroirs order_items,
// stock_movements et assemblages (airtableMirrorEngine.js) avec les records
// bruts du sync. Les tables miroir ne sont pas touchées : tout va dans des
// tables à part (schema.js, « part_stock_* »).
//
// Sync complet (`full`) : la table à part est réalignée sur Airtable (les
// lignes absentes du sync sont retirées). Sync partiel : seuls les records
// reçus sont mis à jour.

import db from '../db/database.js'
import { lookupProduct } from './airtable.js'

const linked = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const first = v => (Array.isArray(v) ? v[0] : v)

function realign(table, keepIds) {
  const keep = new Set(keepIds)
  const del = db.prepare(`DELETE FROM ${table} WHERE airtable_id=?`)
  for (const { airtable_id } of db.prepare(`SELECT DISTINCT airtable_id FROM ${table}`).all()) {
    if (!keep.has(airtable_id)) del.run(airtable_id)
  }
}

// Noms des champs Airtable des articles de commande. Le plan du miroir ne
// connaît que commande / produit / quantité ; « Dans la boite » (import coupé
// par choix, la colonne Boréal reste à Boréal) et « Date de l'envoi » sont lus
// ici sous leur nom actuel.
export const ORDER_ITEM_FIELDS = { order: 'Commande', product: 'Produit', qty: 'Quantité commandée', box: 'Dans la boite', shipped: "Date de l'envoi" }

/** Articles sans commande : ce qu'il faut pour « Envoyé » et « À envoyer ». */
export function recordOrderlessItems(records, fieldMap = {}, { full = false } = {}) {
  const f = { ...ORDER_ITEM_FIELDS, ...pick(fieldMap, ['order', 'product', 'qty']) }
  const upsert = db.prepare(`
    INSERT INTO part_stock_orderless_items (airtable_id, product_id, qty, dans_la_boite, date_de_l_envoi, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(airtable_id) DO UPDATE SET product_id=excluded.product_id, qty=excluded.qty,
      dans_la_boite=excluded.dans_la_boite, date_de_l_envoi=excluded.date_de_l_envoi, updated_at=excluded.updated_at
      WHERE product_id IS NOT excluded.product_id OR qty IS NOT excluded.qty
        OR dans_la_boite IS NOT excluded.dans_la_boite OR date_de_l_envoi IS NOT excluded.date_de_l_envoi`)
  const del = db.prepare('DELETE FROM part_stock_orderless_items WHERE airtable_id=?')
  const kept = []
  db.transaction(() => {
    for (const rec of records) {
      const fields = rec.fields || {}
      if (linked(fields[f.order]).length) { del.run(rec.id); continue }
      kept.push(rec.id)
      upsert.run(rec.id, lookupProduct(linked(fields[f.product])[0]) || null, Number(fields[f.qty]) || 0,
        fields[f.box] ? 1 : 0, first(fields[f.shipped]) || null)
    }
    if (full) realign('part_stock_orderless_items', kept)
  })()
  return kept.length
}

/** « Changement » exact (décimales et signe) de chaque mouvement, et toutes
 *  ses pièces quand il en vise plusieurs (JSON, sinon NULL). */
export function recordMovementChanges(records, fieldMap = {}, { full = false } = {}) {
  const field = fieldMap.qty_change || 'Changement'
  const pieces = fieldMap.product || 'Pièces'
  const upsert = db.prepare(`
    INSERT INTO part_stock_movement_changes (airtable_id, qty_change, product_ids) VALUES (?, ?, ?)
    ON CONFLICT(airtable_id) DO UPDATE SET qty_change=excluded.qty_change, product_ids=excluded.product_ids
      WHERE qty_change IS NOT excluded.qty_change OR product_ids IS NOT excluded.product_ids`)
  db.transaction(() => {
    for (const rec of records) {
      const raw = Number(rec.fields?.[field])
      const ids = linked(rec.fields?.[pieces]).map(lookupProduct).filter(Boolean)
      upsert.run(rec.id, Number.isFinite(raw) ? raw : 0, ids.length > 1 ? JSON.stringify(ids) : null)
    }
    if (full) realign('part_stock_movement_changes', records.map(r => r.id))
  })()
}

/** Tous les produits liés à chaque assemblage. */
export function recordAssemblageProducts(records, fieldMap = {}, { full = false } = {}) {
  const field = fieldMap.product || 'Produit'
  const clear = db.prepare('DELETE FROM part_stock_assemblage_products WHERE airtable_id=?')
  const ins = db.prepare('INSERT OR IGNORE INTO part_stock_assemblage_products (airtable_id, product_id) VALUES (?, ?)')
  db.transaction(() => {
    for (const rec of records) {
      clear.run(rec.id)
      for (const atId of linked(rec.fields?.[field])) {
        const pid = lookupProduct(atId)
        if (pid) ins.run(rec.id, pid)
      }
    }
    if (full) realign('part_stock_assemblage_products', records.map(r => r.id))
  })()
}

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj?.[k]) out[k] = obj[k]
  return out
}
