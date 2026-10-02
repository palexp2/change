// Coût unitaire FIFO des pièces achetées — tenu par Boréal (2026-10-02).
//
// Avant : le champ Airtable « Coût unitaire (FIFO) » était écrit par une
// automatisation Airtable, puis importé dans products.unit_cost. Charles
// débranche cette automatisation : Boréal calcule, écrit products.unit_cost et
// le repousse dans Airtable (le champ est en « bidirectionnel »), pour que les
// formules qui en dépendent là-bas (« Cout unitaire », « Valeur inventaire »,
// coût des BOM) restent justes.
//
// La règle — vérifiée contre l'automatisation Airtable le 2026-10-02 (233
// pièces sur 236 identiques, les 3 autres étaient des coûts pas remis à jour) :
//   - un achat reçu (date de réception complète renseignée) est un lot :
//     quantité commandée × prix unitaire (override payé, sinon facturé) ;
//   - en FIFO, ce qui reste en stock ce sont les lots les PLUS RÉCENTS : on
//     remonte les lots du plus récent au plus ancien jusqu'à couvrir la
//     quantité en inventaire ;
//   - coût unitaire = moyenne pondérée des lots ainsi retenus.
// Pas besoin de l'historique des sorties : la quantité en inventaire suffit.
//
// Écarts volontaires avec Airtable, signalés comme alertes :
//   - lot reçu sans prix (facture pas encore liée) : Airtable le comptait à
//     0 $ et tirait le coût vers le bas ; ici il est exclu de la moyenne —
//     sauf s'il est marqué gratuit à la main (compté à 0 $, sans alerte) ;
//   - stock supérieur à tous les achats reçus : le surplus vient de
//     l'inventaire de départ, le plus ancien stock — valorisé au coût de départ
//     saisi sur la fiche (product_opening_costs), sinon au prix du plus ancien
//     achat connu. Signalé seulement si rien ne permet de le valoriser ;
//   - prix d'un lot très éloigné des autres achats de la même pièce (prix de
//     paquet saisi comme prix unitaire, mauvaise facture liée…) : calculé tel
//     quel, mais signalé — sauf si ce prix a été vérifié à la main.
// Stock nul, ou aucun lot en stock avec un prix : coût = prix du dernier lot
// reçu qui en a un.
// Aucun achat reçu avec prix : le coût en place n'est pas touché.

import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { expenseLinesByPurchase } from './purchaseLinkAudit.js'

// Pièces dont le coût ne vient pas des achats : le coût d'un produit fabriqué
// est celui de son BOM (« Cout unitaire » côté Airtable), un logiciel n'a pas
// de stock.
const NOT_PURCHASED = new Set(['Fabriqué', 'Logiciel'])
// Seuils de l'alerte « prix douteux » : rapport au prix médian des autres lots.
const OUTLIER_HIGH = 2.5
const OUTLIER_LOW = 0.4
// En dessous, l'écart de coût n'est pas réécrit (arrondis d'Airtable).
const COST_EPSILON = 0.005

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Prix payé d'après les factures fournisseurs liées DANS Boréal (QuickBooks
// ou extraction), converties en CAD. Tous les achats d'un coup (~40 ms) :
// mémorisé quelques secondes, le temps d'une passe complète.
let paidCache = { at: 0, map: null }
function paidUnitPrice(purchaseId) {
  if (!paidCache.map || Date.now() - paidCache.at > 30_000) {
    try { paidCache = { at: Date.now(), map: expenseLinesByPurchase() } }
    catch { paidCache = { at: Date.now(), map: {} } }
  }
  const v = paidCache.map[purchaseId]?.unit_price_paid_cad
  return v > 0 ? v : null
}

// « Prix unitaire ($ CAD) » d'un achat, dans l'ordre :
//   1. la valeur relue dans Airtable (purchase_prices) — override payé, sinon
//      facturé d'après les lignes de dépense liées là-bas ;
//   2. à défaut, le prix payé d'après les factures liées dans Boréal (une
//      facture saisie ici n'est pas toujours liée dans Airtable) ;
//   3. en dernier, les anciennes colonnes importées (figées depuis 2026-04).
export function purchaseUnitPrice(p) {
  const cached = p.airtable_id
    ? db.prepare('SELECT unit_price FROM purchase_prices WHERE airtable_id = ?').get(p.airtable_id)
    : null
  if (cached?.unit_price > 0) return cached.unit_price
  const paid = p.id ? paidUnitPrice(p.id) : null
  if (paid) return paid
  if (cached) return null   // Airtable relu : ses 0 $ priment sur les colonnes figées
  for (const col of ['override_prix_unitaire_paye_cad', 'prix_unitaire_facture_cad', 'prix_unitaire_cad']) {
    const n = Number(p[col])
    if (p[col] != null && p[col] !== '' && Number.isFinite(n) && n > 0) return n
  }
  return null
}

const PRICE_FIELD = 'Prix unitaire ($ CAD)'

/**
 * Relit dans Airtable le prix unitaire des achats (tous, ou `recordIds`).
 * Le prix y change sans que l'achat soit touché (une ligne de dépense liée
 * plus tard) : seule une relecture le voit.
 * @returns {number} nombre de prix relus
 */
export async function refreshPurchasePrices(recordIds = null) {
  const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='achats'").get()
  if (!cfg?.base_id || !cfg?.table_id) throw new Error('config Airtable des achats absente')
  const token = await getAccessToken()
  const upsert = db.prepare(`
    INSERT INTO purchase_prices (airtable_id, unit_price, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(airtable_id) DO UPDATE SET unit_price=excluded.unit_price, fetched_at=excluded.fetched_at
  `)
  const now = new Date().toISOString()
  const save = recs => db.transaction(() => {
    for (const r of recs) {
      const v = Number(r.fields?.[PRICE_FIELD])
      upsert.run(r.id, Number.isFinite(v) ? v : null, now)
    }
  })()

  let n = 0
  if (recordIds) {
    for (const id of recordIds) {
      const r = await airtableFetch(`/${cfg.base_id}/${cfg.table_id}/${id}`, token)
      save([r]); n++
    }
    return n
  }
  let offset
  do {
    const q = new URLSearchParams({ pageSize: '100' })
    q.append('fields[]', PRICE_FIELD)
    if (offset) q.set('offset', offset)
    const page = await airtableFetch(`/${cfg.base_id}/${cfg.table_id}?${q}`, token)
    save(page.records || []); n += (page.records || []).length
    offset = page.offset
  } while (offset)
  return n
}

// Date d'entrée du lot : la réception, sinon (date factice 1970 des vieux
// achats Airtable) la commande.
function lotDate(p) {
  const r = String(p.cf_date_de_reception_complete || '')
  return r && r >= '1971' ? r.slice(0, 10) : String(p.date_de_commande || p.created_at || '').slice(0, 10)
}

function isReceived(p) {
  return !!String(p.cf_date_de_reception_complete || '').trim()
}

// Prix vérifié à la main (purchase_price_approvals) — tant qu'il n'a pas changé.
function isPriceApproved(lot) {
  const a = db.prepare('SELECT unit_price FROM purchase_price_approvals WHERE purchase_id = ?').get(lot.purchase_id)
  if (!a) return false
  lot.approved = true
  return Math.abs(a.unit_price - lot.unit_price) < 1e-6
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}

// Achats qui citent la pièce : le lien vit dans `nom_de_la_piece` (record ID
// Airtable, brut ou en tableau JSON), comme pour la fiche Pièce.
function productPurchases(product) {
  const keys = [product.airtable_id, product.id].filter(Boolean)
  if (!keys.length) return []
  const where = keys.map(() => "instr(COALESCE(nom_de_la_piece, ''), ?) > 0").join(' OR ')
  return db.prepare(`
    SELECT id, airtable_id, at_id, nom_de_la_piece, quantite_commande, date_de_commande, created_at,
           cf_date_de_reception_complete, override_prix_unitaire_paye_cad,
           prix_unitaire_facture_cad, prix_unitaire_cad
    FROM purchases WHERE ${where}
  `).all(...keys)
}

/**
 * Calcul FIFO d'une pièce. Lecture seule.
 * @returns {null | { product_id, eligible, cost, qty, covered, uncovered, layers, issues }}
 */
export function computeFifo(productId) {
  const product = db.prepare(
    'SELECT id, airtable_id, procurement_type, stock_qty, unit_cost FROM products WHERE id = ?'
  ).get(productId)
  if (!product) return null
  const eligible = !NOT_PURCHASED.has(product.procurement_type || '')
  const qty = Math.max(num(product.stock_qty), 0)

  const lots = productPurchases(product)
    .filter(p => isReceived(p) && num(p.quantite_commande) > 0)
    .map(p => ({ purchase_id: p.id, at_id: p.at_id, date: lotDate(p), qty: num(p.quantite_commande), unit_price: purchaseUnitPrice(p) }))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.at_id).localeCompare(String(a.at_id), undefined, { numeric: true }))

  // Lots encore en stock : les plus récents, jusqu'à couvrir la quantité.
  const layers = []
  let need = qty
  for (const l of lots) {
    if (need <= 0) break
    const take = Math.min(need, l.qty)
    layers.push({ ...l, qty_in_stock: take })
    need -= take
  }
  const uncovered = need > 1e-9 ? need : 0

  const issues = []
  let value = 0
  let pricedQty = 0
  for (const l of layers) {
    // Lot marqué gratuit à la main (fournisseur qui ne facture pas) : 0 $.
    if (l.unit_price == null && db.prepare(
      'SELECT 1 FROM purchase_price_approvals WHERE purchase_id = ? AND unit_price = 0'
    ).get(l.purchase_id)) {
      l.unit_price = 0
      l.approved = true
    }
    if (l.unit_price == null) {
      l.flag = 'sans_prix'
      issues.push({ kind: 'sans_prix', purchase_id: l.purchase_id, at_id: l.at_id, qty: l.qty_in_stock })
      continue
    }
    value += l.qty_in_stock * l.unit_price
    pricedQty += l.qty_in_stock
    const others = lots.filter(o => o.purchase_id !== l.purchase_id && o.unit_price != null).map(o => o.unit_price)
    const m = median(others)
    if (m && (l.unit_price / m > OUTLIER_HIGH || l.unit_price / m < OUTLIER_LOW) && !isPriceApproved(l)) {
      l.flag = 'prix_douteux'
      issues.push({
        kind: 'prix_douteux', purchase_id: l.purchase_id, at_id: l.at_id,
        unit_price: l.unit_price, median: m, impact: Math.round((l.unit_price - m) * l.qty_in_stock * 100) / 100,
      })
    }
  }
  const opening = db.prepare('SELECT unit_cost FROM product_opening_costs WHERE product_id = ?').get(product.id)?.unit_cost ?? null
  if (uncovered > 0) {
    // Surplus = inventaire de départ : coût saisi à la main, sinon prix du
    // plus ancien achat connu.
    const startCost = opening ?? [...lots].reverse().find(l => l.unit_price != null)?.unit_price ?? null
    if (startCost != null) {
      value += uncovered * startCost
      pricedQty += uncovered
    } else {
      issues.push({ kind: 'stock_sans_achat', qty: uncovered })
    }
  }

  let cost = null
  if (pricedQty > 0) cost = value / pricedQty
  else cost = lots.find(l => l.unit_price != null)?.unit_price ?? opening

  return {
    product_id: product.id,
    eligible,
    cost: cost == null ? null : Math.round(cost * 10000) / 10000,
    current_cost: product.unit_cost,
    opening_cost: opening,
    qty,
    covered: qty - uncovered,
    uncovered,
    layers: layers.map(({ purchase_id, at_id, date, qty_in_stock, unit_price, flag, approved }) =>
      ({ purchase_id, at_id, date, qty_in_stock, unit_price, flag: flag || null, approved: !!approved && !flag })),
    issues: eligible ? issues : [],
  }
}

/**
 * Recalcule et applique le coût FIFO d'une pièce : mémorise le calcul
 * (product_fifo), réécrit products.unit_cost s'il a changé. Ne pousse PAS vers
 * Airtable — l'appelant le fait (réseau, asynchrone).
 * @returns {null | { product_id, changed, from, to, issues }}
 */
export function applyFifo(productId) {
  const r = computeFifo(productId)
  if (!r) return null
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO product_fifo (product_id, cost, qty, uncovered, layers, issues, issue_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET cost=excluded.cost, qty=excluded.qty, uncovered=excluded.uncovered,
      layers=excluded.layers, issues=excluded.issues, issue_count=excluded.issue_count, computed_at=excluded.computed_at
  `).run(r.product_id, r.cost, r.qty, r.uncovered, JSON.stringify(r.layers), JSON.stringify(r.issues), r.issues.length, now)

  const from = r.current_cost == null ? null : num(r.current_cost)
  const changed = r.eligible && r.cost != null && (from == null || Math.abs(from - r.cost) > COST_EPSILON)
  if (changed) {
    // « Cout unitaire » et « Valeur inventaire » sont des formules Airtable
    // qui découlent du FIFO pour une pièce achetée : les aligner tout de suite
    // plutôt qu'attendre leur retour par le sync.
    db.prepare(`
      UPDATE products SET unit_cost = ?, cout_unitaire = ?, valeur_inventaire = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(r.cost, r.cost, Math.round(r.qty * r.cost * 100) / 100, r.product_id)
    // À renvoyer vers Airtable (pushPendingFifoCosts).
    db.prepare('UPDATE product_fifo SET pushed_cost = NULL WHERE product_id = ?').run(r.product_id)
  }
  return { product_id: r.product_id, changed, from, to: r.cost, issues: r.issues }
}

// Pièces citées par un achat (record ID Airtable ou id ERP dans le champ lien).
export function productIdsForPurchase(purchaseId) {
  const p = db.prepare('SELECT nom_de_la_piece FROM purchases WHERE id = ?').get(purchaseId)
  if (!p?.nom_de_la_piece) return []
  let refs
  try { refs = JSON.parse(p.nom_de_la_piece) } catch { refs = String(p.nom_de_la_piece).split(',') }
  if (!Array.isArray(refs)) refs = [refs]
  const out = []
  const stmt = db.prepare('SELECT id FROM products WHERE (airtable_id = ? OR id = ?) AND deleted_at IS NULL')
  for (const ref of refs.map(r => String(r).trim()).filter(Boolean)) {
    const row = stmt.get(ref, ref)
    if (row) out.push(row.id)
  }
  return out
}

export function allFifoProductIds() {
  return db.prepare(
    `SELECT id FROM products WHERE deleted_at IS NULL AND COALESCE(procurement_type, '') NOT IN ('Fabriqué', 'Logiciel')`
  ).all().map(r => r.id)
}
