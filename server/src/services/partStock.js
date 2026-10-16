// Quantités d'inventaire des pièces, recalculées par Boréal (2026-10-15).
//
// Première tranche du déplacement du « seuil dynamique » d'Airtable vers
// Boréal : avant de calculer seuils et quantités à commander, il faut des
// quantités d'entrée fraîches. Les colonnes miroir (stock_qty,
// quantite_a_envoyer, quantite_a_recevoir…) sont des formules / rollups
// Airtable figés au dernier import ; on les refait ici depuis les tables
// Boréal. Lecture seule : rien n'est écrit.
//
// Règles des rollups Airtable (table Pièces), reconstituées le 2026-10-15 en
// comparant aux valeurs live (471/471 pièces sur chaque rollup) :
//   Reçu                 = Σ qté commandée des achats AVEC date de réception
//                          complète (la sentinelle 1970-01-01 compte comme reçu)
//   Quantité à recevoir  = Σ qté commandée des achats SANS date de réception
//   Envoyé               = Σ qté des articles de commande « Dans la boîte »
//                          — ou prélevés / mis dans un envoi par l'expédition
//                          Boréal (depuis 2026-09, elle ne coche plus la case)
//   Quantité à envoyer   = Σ qté des articles SANS date d'envoi (ni envoi
//                          Boréal parti : `shipments.shipped_at`, que le
//                          miroir n'a pas toujours recopié dans l'article)
//   Pièces utilisées     = Σ changement des mouvements « Fabrication »
//   Ajustements positifs = Σ changement « Ajustement (augmentation) »,
//                          « Utilisation de pièces usagés », « Restitution R&D »
//   Ajustements négatifs = Σ changement « Ajustement (diminution) »,
//                          « Utilisation pour le reconditionnement »,
//                          « Prélèvement pour R&D »
//   Fabriqués            = Σ quantités fabriquées des assemblages du produit
// puis les formules :
//   Quantité en inventaire = vide si Logiciel (le miroir ne garde pas ce
//     type : procurement_type vide = non stocké) ; nb de # de série « Disponible
//     - Vente » si la pièce a besoin d'un numéro de série ; sinon
//     Reçu − Envoyé − Utilisées + Aj.+ − Aj.− + Fabriqués + Inventaire de départ
//   Quantité sera disponible = inventaire (vide = 0) − à envoyer + à recevoir

const POSITIVE_ADJ = new Set(['Ajustement (augmentation)', 'Utilisation de pièces usagés', 'Restitution R&D'])
const PICKED = new Set(['Prélevé', "Dans l'envoi"])
const NEGATIVE_ADJ = new Set(['Ajustement (diminution)', 'Utilisation pour le reconditionnement', 'Prélèvement pour R&D'])

const num = v => {
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const filled = v => v != null && String(v).trim() !== ''
const truthy = v => {
  if (v == null) return false
  const s = String(v).trim().toLowerCase()
  return s !== '' && s !== '0' && s !== '0.0' && s !== 'false'
}

// `purchases.nom_de_la_piece` garde les identifiants Airtable des pièces liées,
// en tableau JSON ou en texte séparé par des virgules.
export function parseLinkIds(v) {
  if (!filled(v)) return []
  const s = String(v).trim()
  if (s.startsWith('[')) {
    try { return JSON.parse(s).map(String).filter(Boolean) } catch { /* texte */ }
  }
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

// Le miroir range la valeur absolue arrondie du « Changement » dans `qty` et
// son signe dans `type` (out = négatif) — sauf pour les ajustements, dont le
// signe est perdu. La valeur exacte est gardée à part (`qty_change`, table
// part_stock_movement_changes) ; à défaut (mouvement né dans Boréal),
// movement_value = changement × coût unitaire garde signe et décimales.
export function movementChange(m) {
  if (m.qty_change != null && Number.isFinite(Number(m.qty_change))) return Number(m.qty_change)
  const value = Number(m.movement_value), cost = Number(m.unit_cost)
  if (Number.isFinite(value) && Number.isFinite(cost) && cost !== 0 && value !== 0) return value / cost
  const qty = num(m.qty)
  return m.type === 'out' ? -qty : qty
}

// movementChange() en SQL, pour l'agrégation (alias m = stock_movements,
// c = part_stock_movement_changes).
const MOVEMENT_CHANGE_SQL = `CASE
  WHEN c.qty_change IS NOT NULL THEN c.qty_change
  WHEN m.unit_cost IS NOT NULL AND m.unit_cost <> 0 AND m.movement_value IS NOT NULL AND m.movement_value <> 0 THEN m.movement_value * 1.0 / m.unit_cost
  WHEN m.type = 'out' THEN -m.qty ELSE m.qty END`

const blank = () => ({
  recu: 0, a_recevoir: 0, envoye: 0, a_envoyer: 0, utilisees: 0,
  ajustements_positifs: 0, ajustements_negatifs: 0, fabriques: 0, series_disponibles_vente: 0,
})

/**
 * Calcul pur, sur des lignes déjà lues.
 * @returns {Map<string, object>} id produit → quantités
 */
export function computePartStock({ products, purchases = [], orderItems = [], movements = [], assemblages = [], serials = [] }) {
  const acc = new Map(products.map(p => [p.id, blank()]))
  const byAirtable = new Map(products.filter(p => p.airtable_id).map(p => [p.airtable_id, p.id]))
  const add = (pid, key, v) => { const a = acc.get(pid); if (a) a[key] += v }

  for (const pu of purchases) {
    const key = filled(pu.cf_date_de_reception_complete) ? 'recu' : 'a_recevoir'
    for (const atId of parseLinkIds(pu.nom_de_la_piece)) add(byAirtable.get(atId) || atId, key, num(pu.quantite_commande))
  }
  for (const it of orderItems) {
    if (truthy(it.dans_la_boite) || PICKED.has(it.fulfillment_status)) add(it.product_id, 'envoye', num(it.qty))
    if (!filled(it.date_de_l_envoi) && !filled(it.shipped_at)) add(it.product_id, 'a_envoyer', num(it.qty))
  }
  for (const m of movements) {
    const reason = m.reason || ''
    const key = reason === 'Fabrication' ? 'utilisees'
      : POSITIVE_ADJ.has(reason) ? 'ajustements_positifs'
      : NEGATIVE_ADJ.has(reason) ? 'ajustements_negatifs' : null
    if (!key) continue
    const ids = m.product_ids?.length ? m.product_ids : [m.product_id]
    for (const pid of ids) add(pid, key, movementChange(m))
  }
  for (const a of assemblages) {
    // Un assemblage peut fabriquer plusieurs produits : chacun reçoit la quantité.
    const ids = a.product_ids?.length ? a.product_ids : [a.product_id]
    for (const pid of ids) add(pid, 'fabriques', num(a.qty_produced))
  }
  for (const s of serials) if (s.status === 'Disponible - Vente') add(s.product_id, 'series_disponibles_vente', 1)

  const out = new Map()
  for (const p of products) {
    const a = acc.get(p.id)
    const depart = num(p.inventaire_de_depart)
    let inventaire
    if (!p.procurement_type || p.procurement_type === 'Logiciel') inventaire = null
    else if (truthy(p.besoin_d_un_numero_de_serie)) inventaire = a.series_disponibles_vente
    else inventaire = a.recu - a.envoye - a.utilisees + a.ajustements_positifs - a.ajustements_negatifs + a.fabriques + depart
    const sera = (inventaire ?? 0) - a.a_envoyer + a.a_recevoir
    out.set(p.id, { ...a, inventaire_de_depart: depart, inventaire, sera_disponible: sera })
  }
  return out
}

/** Lit les tables Boréal et calcule. Lecture seule. `db` : connexion à
 *  utiliser (par défaut celle du serveur). */
export async function loadPartStock(db = null) {
  if (!db) db = (await import('../db/database.js')).default
  const assemblyProducts = new Map()
  for (const r of db.prepare('SELECT airtable_id, product_id FROM part_stock_assemblage_products').all()) {
    if (!assemblyProducts.has(r.airtable_id)) assemblyProducts.set(r.airtable_id, [])
    assemblyProducts.get(r.airtable_id).push(r.product_id)
  }
  return computePartStock({
    products: db.prepare(`SELECT id, airtable_id, procurement_type, besoin_d_un_numero_de_serie, inventaire_de_depart FROM products`).all(),
    purchases: db.prepare(`SELECT nom_de_la_piece, quantite_commande, cf_date_de_reception_complete FROM purchases`).all(),
    // + les anciens articles sans commande, gardés hors de order_items
    orderItems: db.prepare(`SELECT oi.product_id, oi.qty, oi.dans_la_boite, oi.fulfillment_status, oi.date_de_l_envoi, s.shipped_at
      FROM order_items oi LEFT JOIN shipments s ON s.id = oi.shipment_id
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.deleted_at IS NULL
      UNION ALL
      SELECT product_id, qty, dans_la_boite, NULL, date_de_l_envoi, NULL FROM part_stock_orderless_items`).all(),
    // Agrégés par pièce et type dans SQL (24 000 lignes) ; même règle que
    // movementChange(). Les rares mouvements multi-pièces restent ligne à ligne.
    movements: [
      ...db.prepare(`SELECT m.product_id, m.reason, SUM(${MOVEMENT_CHANGE_SQL}) AS qty_change
        FROM stock_movements m LEFT JOIN part_stock_movement_changes c ON c.airtable_id = m.airtable_id
        WHERE c.product_ids IS NULL GROUP BY m.product_id, m.reason`).all(),
      ...db.prepare(`SELECT m.product_id, m.reason, ${MOVEMENT_CHANGE_SQL} AS qty_change, c.product_ids
        FROM part_stock_movement_changes c JOIN stock_movements m ON m.airtable_id = c.airtable_id
        WHERE c.product_ids IS NOT NULL`).all()
        .map(m => ({ ...m, product_ids: JSON.parse(m.product_ids) })),
    ],
    assemblages: db.prepare(`SELECT airtable_id, product_id, qty_produced FROM assemblages WHERE deleted_at IS NULL`).all()
      .map(a => ({ ...a, product_ids: assemblyProducts.get(a.airtable_id) || null })),
    serials: db.prepare(`SELECT product_id, status FROM serial_numbers WHERE deleted_at IS NULL`).all(),
  })
}
