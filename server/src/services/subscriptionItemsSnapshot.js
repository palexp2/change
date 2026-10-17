// Helpers pour gérer les snapshots d'items d'abonnement Stripe.
//
// Pourquoi : un webhook customer.subscription.updated ne contient que l'état
// *nouveau* du sub. Pour pouvoir afficher dans le dashboard les produits
// ajoutés/retirés lors d'un upgrade/downgrade dès la réception du webhook
// (sans attendre la prochaine facture), on persiste deux snapshots sur l'event
// (`items_before_json` / `items_after_json`) et on maintient un miroir
// `subscription_current_items` qui sert de "before" pour le prochain event.

import db from '../db/database.js'

// Convertit `sub.items.data` (Stripe) vers le format snapshot canonique.
// Tolérant : price/recurring peuvent être absents (donnée legacy / item
// ad-hoc), on retourne null sur les champs non disponibles plutôt que
// d'exclure la ligne.
export function extractItemsFromStripeSub(sub) {
  const data = sub?.items?.data
  if (!Array.isArray(data)) return []
  return data.map(item => {
    const price = item?.price || null
    const productRef = price?.product
    const productId = typeof productRef === 'string'
      ? productRef
      : (productRef?.id || null)
    const productName = (typeof productRef === 'object' && productRef?.name) || null
    return {
      stripe_item_id: item?.id || null,
      stripe_price_id: price?.id || null,
      stripe_product_id: productId,
      name: productName || price?.nickname || null,
      quantity: item?.quantity ?? 1,
      unit_amount: price?.unit_amount ?? null,
      currency: (price?.currency || '').toUpperCase() || null,
      recurring_interval: price?.recurring?.interval || null,
      recurring_interval_count: price?.recurring?.interval_count || null,
      // Métadonnées de la ligne (ex. erp_contact_id du signataire d'une page).
      ...(item?.metadata && Object.keys(item.metadata).length ? { metadata: item.metadata } : {}),
    }
  })
}

export function getCurrentItemsSnapshot(subscriptionId) {
  if (!subscriptionId) return null
  const row = db.prepare(
    'SELECT items_json FROM subscription_current_items WHERE subscription_id = ?'
  ).get(subscriptionId)
  if (!row) return null
  try { return JSON.parse(row.items_json) } catch { return null }
}

export function setCurrentItemsSnapshot(subscriptionId, items) {
  if (!subscriptionId || !Array.isArray(items)) return
  const json = JSON.stringify(items)
  db.prepare(`
    INSERT INTO subscription_current_items (subscription_id, items_json, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(subscription_id) DO UPDATE SET
      items_json = excluded.items_json,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(subscriptionId, json)
}

// Signature contractuelle d'un abonnement : ce que le client a acheté (prix,
// quantité, montant unitaire, cadence), ses rabais actifs et l'essai en cours.
// Un upgrade/downgrade n'est enregistré que si elle change : un montant
// recalculé seul (taxes incluses → hors taxes, facture au prorata avant
// l'annulation) n'est pas un mouvement (14 oct. 2026 : 103 faux mouvements).
// Rabais : l'id du Discount (`di_…`), présent que `discounts` soit expandé
// (webhook) ou non (sync polling) ; à défaut, le coupon et son montant.
function discountKey(d) {
  if (!d) return null
  if (typeof d === 'string') return d
  if (d.id) return d.id
  const c = d.coupon || d.source?.coupon
  if (!c) return null
  return `${c.id || ''}:${c.amount_off ?? ''}:${c.percent_off ?? ''}`
}

export function contractSignature(sub) {
  const key = o => JSON.stringify(o)
  const items = extractItemsFromStripeSub(sub)
    .map(it => ({
      price: it.stripe_price_id,
      quantity: Number(it.quantity ?? 1),
      unit_amount: it.unit_amount ?? null,
      interval: it.recurring_interval,
      interval_count: it.recurring_interval_count ?? null,
    }))
    .sort((a, b) => key(a).localeCompare(key(b)))
  const list = Array.isArray(sub?.discounts) && sub.discounts.length > 0
    ? sub.discounts
    : (sub?.discount ? [sub.discount] : [])
  const discounts = list.map(discountKey).filter(Boolean).sort()
  return { items, discounts, trialing: sub?.status === 'trialing' }
}

// Code promo saisi par le client (colonne « Code promo » de /abonnements) :
// le `code` du promotion code si `discounts.promotion_code` est expandé, sinon
// le nom (ou l'id) du coupon appliqué à la main. null si aucun rabais lisible.
export function promoCodeOf(sub) {
  const list = Array.isArray(sub?.discounts) && sub.discounts.length > 0
    ? sub.discounts
    : (sub?.discount ? [sub.discount] : [])
  const codes = list.filter(d => d && typeof d === 'object').map(d => {
    if (d.promotion_code?.code) return d.promotion_code.code
    const c = d.coupon || d.source?.coupon
    return (c && typeof c === 'object') ? (c.name || c.id) : null
  }).filter(Boolean)
  return codes.length ? [...new Set(codes)].join(', ') : null
}

export function sameContract(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b)
}

// Prix catalogue mensuel des items d'une signature (cents) : sert à reconnaître
// un changement d'items neutre (nouveau prix, même montant).
export function signatureListAmount(sig) {
  let total = 0
  for (const it of sig?.items || []) {
    const line = (Number(it.unit_amount) || 0) * (Number(it.quantity) || 1)
    const n = Number(it.interval_count) || 1
    total += it.interval === 'year' ? line / (12 * n) : it.interval === 'week' ? line * 4.333 / n : line / n
  }
  return Math.round(total)
}

export function getContractSignature(subscriptionId) {
  if (!subscriptionId) return null
  const raw = db.prepare(
    'SELECT signature_json FROM subscription_current_items WHERE subscription_id = ?'
  ).pluck().get(subscriptionId)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// `items` ne sert qu'à créer la ligne du miroir si elle n'existe pas encore.
export function setContractSignature(subscriptionId, signature, items = []) {
  if (!subscriptionId || !signature) return
  db.prepare(`
    INSERT INTO subscription_current_items (subscription_id, items_json, signature_json, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(subscription_id) DO UPDATE SET signature_json = excluded.signature_json
  `).run(subscriptionId, JSON.stringify(items || []), JSON.stringify(signature))
}

// Normalise un libellé d'item pour comparer entre une description de facture
// (ex. "1 × Roll-Up Ventilation (motors not included) (at $105.00 / month)")
// et un nom de produit Stripe ("Roll-Up Ventilation (motors not included)").
function normalizeItemName(raw) {
  if (!raw) return ''
  let s = String(raw).trim().replace(/\s+/g, ' ')
  s = s.replace(/^free trial for\s+\d+\s*[×xX]\s*/i, '')
  s = s.replace(/^free trial for\s+/i, '')
  s = s.replace(/^trial period for\s+/i, '')
  s = s.replace(/^période d'essai pour\s*/i, '')
  s = s.replace(/^\d+\s*[×xX]\s*/, '')
  s = s.replace(/\s*\((?:at|à)\s*\$[\d,]+(?:\.\d+)?\s*(?:\/\s*\w+)?\)\s*$/i, '')
  return s.trim().toLowerCase()
}

// Match key pour comparer un item d'un snapshot à l'autre. Priorité :
//   stripe_price_id > stripe_product_id > nom normalisé
// Le nom normalisé est crucial pour les snapshots reconstruits depuis les
// factures legacy (où price_id/product_id sont NULL en DB).
function lineAmount(it) {
  return (Number(it?.unit_amount) || 0) * (Number(it?.quantity) || 1)
}

// Indexe un snapshot sur trois clés (price_id, product_id, nom normalisé)
// pour permettre un matching tolérant entre snapshots issus de sources
// différentes : les snapshots reconstruits depuis stripe_invoice_items legacy
// n'ont souvent que la `description` (pas les ids), tandis que ceux extraits
// de l'API Stripe ont les ids.
function indexSnapshot(items) {
  const byPrice = new Map()
  const byProduct = new Map()
  const byName = new Map()
  for (const it of items) {
    if (it?.stripe_price_id) byPrice.set(it.stripe_price_id, it)
    if (it?.stripe_product_id) byProduct.set(it.stripe_product_id, it)
    const n = normalizeItemName(it?.name)
    if (n) byName.set(n, it)
  }
  return { byPrice, byProduct, byName }
}

function findMatch(it, idx) {
  if (it?.stripe_price_id && idx.byPrice.has(it.stripe_price_id)) return idx.byPrice.get(it.stripe_price_id)
  if (it?.stripe_product_id && idx.byProduct.has(it.stripe_product_id)) return idx.byProduct.get(it.stripe_product_id)
  const n = normalizeItemName(it?.name)
  if (n && idx.byName.has(n)) return idx.byName.get(n)
  return null
}

// Calcule le diff entre deux snapshots (before, after) pour un upgrade ou
// downgrade. Pour upgrade : items ajoutés ou dont le montant total a augmenté.
// Pour downgrade : items retirés ou dont le montant total a baissé.
// Retourne [{ stripe_product_id, name, quantity, ... }, ...]
export function diffSnapshots(before, after, direction) {
  const beforeArr = Array.isArray(before) ? before : []
  const afterArr = Array.isArray(after) ? after : []
  const beforeIdx = indexSnapshot(beforeArr)
  const afterIdx = indexSnapshot(afterArr)
  const out = []
  if (direction === 'upgrade') {
    for (const it of afterArr) {
      const prev = findMatch(it, beforeIdx)
      if (!prev || lineAmount(it) > lineAmount(prev) + 0.5) out.push(it)
    }
  } else if (direction === 'downgrade') {
    for (const prev of beforeArr) {
      const it = findMatch(prev, afterIdx)
      if (!it) out.push(prev)
      else if (lineAmount(it) < lineAmount(prev) - 0.5) out.push(it)
    }
  }
  return out
}

// Résout le product_id ERP pour un snapshot d'items. Les snapshots stockent
// le stripe_product_id ; on cherche le product_id ERP correspondant via la
// table stripe_invoice_items qui a déjà fait le lien.
// Mutation in-place : ajoute `product_id` (ERP) et complète `name` depuis
// products.name_fr quand on a un product_id.
export function enrichItemsWithErpProductId(items) {
  if (!Array.isArray(items) || items.length === 0) return items
  const stripeIds = [...new Set(items.map(it => it.stripe_product_id).filter(Boolean))]
  const productIdByStripeId = new Map()
  const erpProductNames = new Map()
  const stripeProductNames = new Map()
  if (stripeIds.length > 0) {
    const placeholders = stripeIds.map(() => '?').join(',')
    // Pour chaque stripe_product_id, on prend le product_id ERP le plus
    // récemment vu sur stripe_invoice_items (n'importe quelle ligne suffit —
    // un même produit Stripe ne mappe qu'à un produit ERP).
    const rows = db.prepare(`
      SELECT stripe_product_id, product_id
      FROM stripe_invoice_items
      WHERE stripe_product_id IN (${placeholders})
        AND product_id IS NOT NULL
      GROUP BY stripe_product_id
    `).all(...stripeIds)
    for (const r of rows) {
      if (r.product_id) productIdByStripeId.set(r.stripe_product_id, r.product_id)
    }
    // Produit jamais facturé (abonnement neuf, annulé avant sa 1re facture) :
    // le lien catalogue de vente ↔ produit Stripe, puis les alias.
    for (const table of ['product_stripe_products', 'product_stripe_aliases']) {
      const missing = stripeIds.filter(sid => !productIdByStripeId.has(sid))
      if (!missing.length) break
      const links = db.prepare(`
        SELECT stripe_product_id, product_id FROM ${table}
        WHERE stripe_product_id IN (${missing.map(() => '?').join(',')}) AND product_id IS NOT NULL
        GROUP BY stripe_product_id
      `).all(...missing)
      for (const r of links) productIdByStripeId.set(r.stripe_product_id, r.product_id)
    }
    // Nom Stripe du produit (le snapshot n'a pas de nom quand Stripe n'a pas
    // développé `price.product`).
    for (const r of db.prepare(`SELECT id, name FROM stripe_products WHERE id IN (${placeholders})`).all(...stripeIds)) {
      if (r.name) stripeProductNames.set(r.id, r.name)
    }
    const erpIds = [...productIdByStripeId.values()]
    if (erpIds.length > 0) {
      const ph = erpIds.map(() => '?').join(',')
      const prods = db.prepare(`SELECT id, name_fr FROM products WHERE id IN (${ph})`).all(...erpIds)
      for (const p of prods) erpProductNames.set(p.id, p.name_fr)
    }
  }
  return items.map(it => {
    const productId = it.stripe_product_id ? productIdByStripeId.get(it.stripe_product_id) : null
    return {
      ...it,
      product_id: productId || null,
      name: it.name || stripeProductNames.get(it.stripe_product_id) || (productId ? erpProductNames.get(productId) : null) || null,
    }
  })
}
