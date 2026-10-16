// Colonnes « seuil dynamique » des pièces : Boréal en est propriétaire depuis
// 2026-10-15 (automation système `sys_dynamic_threshold`). L'import Airtable de
// ces colonnes est gelé (migration 142, airtable_frozen_columns) : les
// formules Airtable étaient périmées dans Boréal (la vue « À acheter » ne
// montrait que 4 pièces sur 15). Rien n'est poussé vers Airtable.
//
// Écrit par recalcul complet (services/dynamicThreshold.js) :
//   - quand une entrée change (change_log des achats, articles, mouvements,
//     assemblages, nomenclature, pièces, séries, envois) — poll 15 s ;
//   - toutes les 5 minutes, en filet ;
// en UNE transaction, seulement les valeurs qui changent. Aucun message temps
// réel : le change_log suffit au rafraîchissement différé des navigateurs.

import db from '../db/database.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { loadDynamicThresholds, isKanban, primeDynamicThresholdsCache } from './dynamicThreshold.js'
import { writeBackRecord, isAirtableComputedKey, dynamicDirectionKey } from './airtableWriteback.js'
import { ERP_COMPUTED_COLUMNS } from './customFieldWritability.js'

const AUTOMATION_ID = 'sys_dynamic_threshold'
const POLL_MS = 15_000
const FULL_PASS_MS = 5 * 60 * 1000

// Colonnes calculées (gelées à l'import) ; seuil_min_produits_finis n'est
// écrit que pour un kanban — le seuil d'un produit fini reste saisi.
export const OWNED_COLUMNS = [
  'quantite_a_commander', 'seuil_dynamique', 'restant_avant_seuil_dynamique',
  'pourcentage_restant_seuil_dynamique', 'quantite_sera_disponible',
  'seuil_minimum_produits_x_quantite_necessaire',
  'quantite_dans_les_produits_produits_x_quantite_necessaire', 'quantite_a_recevoir',
]

const INPUT_TABLES = ['purchases', 'order_items', 'stock_movements', 'assemblages', 'bom_items', 'products', 'serial_numbers', 'shipments']

const round = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6)

/** Valeurs des colonnes pour une pièce, à partir du calcul. */
export function columnsFor(product, t) {
  const restant = t.sera_disponible - t.seuil_dynamique
  const out = {
    quantite_a_commander: Math.ceil(round(t.quantite_a_commander)),
    seuil_dynamique: round(t.seuil_dynamique),
    restant_avant_seuil_dynamique: round(restant),
    // Airtable : restant / seuil, vide si seuil ≤ 0 — stocké en points (le
    // champ s'affiche « % » sans multiplier)
    pourcentage_restant_seuil_dynamique: t.seuil_dynamique > 0 ? round(restant / t.seuil_dynamique * 100) : null,
    quantite_sera_disponible: round(t.sera_disponible),
    seuil_minimum_produits_x_quantite_necessaire: round(t.seuil_min_produits),
    quantite_dans_les_produits_produits_x_quantite_necessaire: round(t.qte_dans_les_produits),
    quantite_a_recevoir: round(t.stock?.a_recevoir ?? 0),
  }
  if (isKanban(product)) out.seuil_min_produits_finis = round(t.seuil_min_produits_finis)
  // À fabriquer (migration 145) : même règle que l'étape Production de la
  // priorité d'assemblage ; vide pour ce qui ne se fabrique pas.
  out.quantite_a_fabriquer = product.procurement_type === 'Fabriqué'
    ? Math.max(0, Math.ceil(round(t.seuil_min_produits_finis - t.sera_disponible)))
    : null
  // Quantité en inventaire (migration 143) ; vide pour un logiciel → on n'y touche pas.
  if (t.stock?.inventaire != null) out.stock_qty = Math.round(t.stock.inventaire)
  return out
}

const same = (a, b) => {
  if ((a == null || a === '') && b == null) return true
  if (a == null || a === '' || b == null) return false
  return Math.abs(Number(a) - b) < 1e-6
}

/** Recalcule tout et écrit ce qui a changé. @returns {{ changed, rows }} */
export async function writeDynamicThresholds() {
  const thresholds = await loadDynamicThresholds()
  primeDynamicThresholdsCache(thresholds)
  const cols = [...OWNED_COLUMNS, 'seuil_min_produits_finis', 'stock_qty', 'quantite_a_fabriquer']
  const rows = db.prepare(`SELECT id, type, procurement_type, ${cols.join(', ')} FROM products`).all()
  const stmts = new Map()
  const pushed = []   // { id, cols } — à pousser vers Airtable après la transaction
  const targets = airtablePushTargets()
  let changed = 0
  db.transaction(() => {
    for (const p of rows) {
      const t = thresholds.get(p.id)
      if (!t) continue
      const target = columnsFor(p, t)
      const diff = Object.keys(target).filter(c => !same(p[c], target[c]))
      if (!diff.length) continue
      const key = diff.join(',')
      if (!stmts.has(key)) stmts.set(key, db.prepare(`UPDATE products SET ${diff.map(c => `${c} = ?`).join(', ')} WHERE id = ?`))
      stmts.get(key).run(...diff.map(c => target[c]), p.id)
      const cols = diff.filter(c => targets.has(c))
      if (cols.length) pushed.push({ id: p.id, cols })
      changed++
    }
  })()
  // « Calculé par Boréal » mappé vers un champ Airtable écrivable : Boréal →
  // Airtable est son seul sens. En série, hors transaction.
  for (const { id, cols } of pushed) {
    await writeBackRecord('pieces', id, cols).catch(e => console.warn('[dynamicThreshold] Airtable :', e.message))
  }
  return { changed, rows: rows.length, pushed: pushed.length }
}

// Colonnes calculées mappées vers un champ Airtable qui accepte l'écriture.
function airtablePushTargets() {
  try {
    const mapped = db.prepare(`SELECT column_name FROM airtable_field_mappings
      WHERE erp_table = 'products' AND import_disabled IS NOT 1 AND column_name IS NOT NULL`).all().map(r => r.column_name)
    return new Set(mapped.filter(c => ERP_COMPUTED_COLUMNS.products.has(c)
      && !isAirtableComputedKey('pieces', dynamicDirectionKey(c))))
  } catch { return new Set() }
}

let passing = false
async function pass(source) {
  if (passing || !isSystemAutomationActive(AUTOMATION_ID)) return 0
  passing = true
  const t0 = Date.now()
  try {
    const r = await writeDynamicThresholds()
    // Une passe sans écriture ne remplit pas l'historique.
    if (r.changed) logSystemRun(AUTOMATION_ID, { status: 'success', duration_ms: Date.now() - t0, result: `${source} : ${r.changed} pièce(s) mise(s) à jour sur ${r.rows}` })
    return r.changed
  } catch (e) {
    logSystemRun(AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, error: e })
    console.error('[dynamicThreshold] passe :', e.message)
    return 0
  } finally {
    passing = false
  }
}

// Nos propres écritures sur `products` repassent dans le change_log : elles
// sont ignorées (sinon chaque passe en déclencherait une autre).
let selfWriteUntil = 0
const watcher = createChangeLogWatcher({
  name: 'dynamicThresholdWatcher',
  intervalMs: POLL_MS,
  tables: INPUT_TABLES,
  maxIdTables: INPUT_TABLES,
  automationId: AUTOMATION_ID,
  isEnabled: () => isSystemAutomationActive(AUTOMATION_ID),
  onRows: async (rows, { advance }) => {
    if (!rows.length) return 0
    advance(rows[rows.length - 1].id)
    if (rows.every(r => r.table_name === 'products' && r.id <= selfWriteUntil)) return 0
    const n = await pass('changement')
    selfWriteUntil = watcher.maxChangeLogId()
    return n
  },
})

let fullTimer = null
export function startDynamicThresholdWatcher() {
  watcher.start()
  const tick = async () => {
    await pass('passe régulière')
    selfWriteUntil = watcher.maxChangeLogId()
  }
  setTimeout(tick, 20_000).unref?.()
  fullTimer = setInterval(tick, FULL_PASS_MS)
  fullTimer.unref?.()
}

export function stopDynamicThresholdWatcher() {
  watcher.stop()
  if (fullTimer) clearInterval(fullTimer)
  fullTimer = null
}
