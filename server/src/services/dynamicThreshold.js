// Seuil dynamique des pièces et quantité à commander, calculés par Boréal
// (2026-10-15) sur les quantités natives de services/partStock.js — remplace
// les rollups / formules Airtable de la table Pièces. Lecture seule.
//
// Pour une pièce, sur ses parents dans la nomenclature (bom_items) :
//   seuil min (produits × qté nécessaire) sm = Σ seuil min. produits finis du parent × qté requise
//   qté dans les produits (produits × qté nécessaire) qp = Σ « sera disponible » du parent × qté requise
//   seuil dynamique dyn = sm − qp
// Un produit fini garde le « Seuil min. produits finis » saisi. Un KANBAN
// (étape intermédiaire de production) prend max(0, son seuil dynamique) :
// sa valeur cascade sur ses propres pièces — calcul multi-niveaux, parents
// d'abord, avec garde contre les cycles.
//
// Quantité à commander (formule Airtable, à l'identique) :
//   MAX( dispo − dyn < 0 ? sm×2 − dispo − qp : 0,
//        dispo < inventaire minimum ? inventaire minimum×2 − dispo : 0 )

const num = v => {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const isKanban = p => String(p.type || '').trim().toUpperCase() === 'KANBAN'

/**
 * @param products  [{ id, type, seuil_min_produits_finis, min_stock }]
 * @param bom       [{ product_id (parent), component_id, qty_required }]
 * @param available Map id → « sera disponible » (nombre)
 * @returns Map id → { seuil_min_produits, qte_dans_les_produits, seuil_dynamique,
 *   seuil_min_produits_finis, sera_disponible, inventaire_minimum,
 *   restant_avant_seuil_dynamique, quantite_a_commander, cycle }
 */
export function computeDynamicThresholds({ products, bom, available }) {
  const byId = new Map(products.map(p => [p.id, p]))
  const parentsOf = new Map()
  for (const b of bom) {
    if (!b.product_id || !b.component_id || !byId.has(b.product_id) || !byId.has(b.component_id)) continue
    if (!parentsOf.has(b.component_id)) parentsOf.set(b.component_id, [])
    parentsOf.get(b.component_id).push({ parent: b.product_id, qty: num(b.qty_required) })
  }
  const dispo = id => num(available.get(id))

  const base = new Map() // id → { sm, qp, cycle }
  const minOf = new Map() // id → seuil min. produits finis effectif
  const visiting = new Set()

  function sums(id) {
    if (base.has(id)) return base.get(id)
    if (visiting.has(id)) return { sm: 0, qp: 0, cycle: true }
    visiting.add(id)
    let sm = 0, qp = 0, cycle = false
    for (const { parent, qty } of parentsOf.get(id) || []) {
      const m = effectiveMin(parent)
      if (m.cycle) cycle = true
      sm += m.value * qty
      qp += dispo(parent) * qty
    }
    visiting.delete(id)
    const out = { sm, qp, cycle }
    base.set(id, out)
    return out
  }

  function effectiveMin(id) {
    if (minOf.has(id)) return minOf.get(id)
    const p = byId.get(id)
    let out
    if (isKanban(p)) {
      if (visiting.has(id)) return { value: 0, cycle: true }
      const s = sums(id)
      out = { value: Math.max(0, s.sm - s.qp), cycle: s.cycle }
    } else {
      out = { value: num(p.seuil_min_produits_finis), cycle: false }
    }
    minOf.set(id, out)
    return out
  }

  const result = new Map()
  for (const p of products) {
    const { sm, qp, cycle } = sums(p.id)
    const dyn = sm - qp
    const d = dispo(p.id)
    const invMin = num(p.min_stock)
    const qty = Math.max(
      d - dyn < 0 ? sm * 2 - d - qp : 0,
      d < invMin ? invMin * 2 - d : 0,
    )
    result.set(p.id, {
      seuil_min_produits: sm,
      qte_dans_les_produits: qp,
      seuil_dynamique: dyn,
      seuil_min_produits_finis: effectiveMin(p.id).value,
      sera_disponible: d,
      inventaire_minimum: invMin,
      restant_avant_seuil_dynamique: d - dyn,
      quantite_a_commander: qty,
      cycle,
    })
  }
  return result
}

/** Lit Boréal (quantités natives + nomenclature) et calcule. */
export async function loadDynamicThresholds(db = null) {
  if (!db) db = (await import('../db/database.js')).default
  const { loadPartStock } = await import('./partStock.js')
  const stock = await loadPartStock(db)
  const available = new Map([...stock].map(([id, s]) => [id, s.sera_disponible]))
  const thresholds = computeDynamicThresholds({
    products: db.prepare('SELECT id, type, seuil_min_produits_finis, min_stock FROM products').all(),
    bom: db.prepare('SELECT product_id, component_id, qty_required FROM bom_items').all(),
    available,
  })
  for (const [id, t] of thresholds) t.stock = stock.get(id)
  return thresholds
}

// Calcul servi à l'écran Priorité d'assemblage, à la fiche pièce et au
// pré-remplissage d'un achat : ~170 ms, gardé 30 s (une seule passe en vol).
const CACHE_MS = 30_000
let cache = { at: 0, data: null, inflight: null }

export async function getDynamicThresholdsCached() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data
  if (!cache.inflight) {
    cache.inflight = loadDynamicThresholds()
      .then(data => { cache = { at: Date.now(), data, inflight: null }; return data })
      .catch(e => { cache.inflight = null; throw e })
  }
  return cache.inflight
}

/** Le dernier calcul complet de l'écrivain sert aussi l'écran. */
export function primeDynamicThresholdsCache(data) {
  cache = { at: Date.now(), data, inflight: null }
}

/** Forme compacte pour le client. */
export function publicThreshold(t) {
  if (!t) return null
  const r = v => Math.round(v * 100) / 100
  return {
    sera_disponible: r(t.sera_disponible),
    inventaire: t.stock?.inventaire == null ? null : r(t.stock.inventaire),
    seuil_dynamique: r(t.seuil_dynamique),
    seuil_min_produits_finis: r(t.seuil_min_produits_finis),
    inventaire_minimum: t.inventaire_minimum,
    quantite_a_commander: Math.ceil(r(t.quantite_a_commander)),
  }
}
