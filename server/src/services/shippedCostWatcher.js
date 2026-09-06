// shippedCostWatcher — gèle le « coût total au moment de l'envoi » d'une ligne
// de commande dès qu'un envoi lui est associé.
//
// Pourquoi un watcher et pas un appel dans les routes : un envoi se crée dans
// Boréal (fiche commande, mode expédition, étiquette Novoxpress) COMME dans
// Airtable (syncEnvois rattache les « items expédiés » à
// order_items.shipment_id). Les deux origines n'ont qu'un point commun :
// l'écriture DB sur la ligne. On tail donc change_log(order_items) — journal
// alimenté par triggers SQLite, donc exhaustif quelle que soit l'origine — et
// on gèle la ligne qui satisfait la condition de déclenchement.
//
// Condition par défaut : `shipment_id` non vide. Elle est éditable dans la
// fiche de l'automation système `sys_order_item_shipped_cost` (table
// order_items, colonne physique ou champ personnalisé), comme celle du constat
// de vente. Config illisible ou invalide → repli dur sur le défaut, jamais de
// gel silencieusement abandonné.
//
// Le curseur démarre à la pointe de change_log : rien d'historique n'est
// rempli, seuls les prochains envois le sont. Désactiver l'automation avance le
// curseur sans traiter (pas de rattrapage au réveil).

import db from '../db/database.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { buildTriggerPredicate, triggerColumns } from './fieldRuleEngine.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { freezeShippedTotalCost } from './shippedCost.js'

const POLL_MS = 5000
const BATCH = 500
const AUTOMATION_ID = 'sys_order_item_shipped_cost'
const DEFAULT_TRIGGER = { erp_table: 'order_items', column: 'shipment_id', op: 'not_null' }
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

// Condition configurée par l'utilisateur sur l'automation système.
export function loadTriggerConfig() {
  try {
    const row = db.prepare(
      'SELECT trigger_config FROM automations WHERE id = ? AND system = 1'
    ).get(AUTOMATION_ID)
    const tc = JSON.parse(row?.trigger_config || '{}')
    if (tc.column || tc.conditions) return tc
  } catch (e) {
    console.error('[shippedCostWatcher] trigger_config illisible, repli shipment_id not_null :', e.message)
  }
  return DEFAULT_TRIGGER
}

// Matcher « cette ligne satisfait-elle la condition ? ». Une condition qui
// porte sur un champ personnalisé (cf_*, lookup/rollup/formule) passe par la
// vue order_items_v qui les matérialise. Lève si la config est inutilisable.
export function buildTriggerMatcher(tc) {
  const { predicate, params } = buildTriggerPredicate(tc)
  const physical = new Set(db.prepare('PRAGMA table_info(order_items)').all().map(c => c.name))
  const cols = triggerColumns(tc)
  if (!cols.length) throw new Error('condition sans colonne')
  for (const c of cols) {
    if (!IDENT_RE.test(c)) throw new Error(`colonne invalide: ${c}`)
  }
  let rel = 'order_items'
  if (cols.some(c => !physical.has(c))) {
    const hasView = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'order_items_v'"
    ).get()
    if (!hasView) throw new Error("champ personnalisé référencé mais la vue order_items_v n'existe pas")
    rel = 'order_items_v'
  }
  const stmt = db.prepare(`SELECT t.id FROM ${rel} t WHERE (${predicate}) AND t.id = ?`)
  return { match: (recordId) => !!stmt.get(...params, recordId) }
}

function loadMatcher() {
  try {
    return buildTriggerMatcher(loadTriggerConfig())
  } catch (e) {
    console.error('[shippedCostWatcher] condition configurée invalide, repli shipment_id not_null :', e.message)
    return buildTriggerMatcher(DEFAULT_TRIGGER)
  }
}

// Une ligne de journal par PASSE, pas par ligne de commande : un sync Airtable
// qui rattache 40 items ne doit pas noyer l'historique de l'automation.
function logPass(frozen, errors) {
  if (!frozen.length && !errors.length) return
  const detail = frozen.map(f => {
    const parts = [`${f.total.toFixed(2)} $`]
    if (f.serial_count) parts.push(`${f.valued_serials}/${f.serial_count} série(s) valorisée(s)`)
    if (f.unserialized_qty) parts.push(`${f.unserialized_qty} × ${f.unit_cost.toFixed(2)} $ au coût de la pièce`)
    if (f.serials_without_value.length) parts.push(`sans valeur de fabrication : ${f.serials_without_value.join(', ')}`)
    return `${f.item_id} → ${parts.join(' · ')}`
  })
  logSystemRun(AUTOMATION_ID, {
    status: errors.length ? 'error' : 'success',
    result: [
      `${frozen.length} ligne(s) gelée(s)`,
      ...detail,
      errors.length ? `Erreurs : ${errors.join(' | ')}` : null,
    ].filter(Boolean).join('\n'),
    error: errors.length ? errors.join(' | ') : undefined,
    triggerData: { frozen: frozen.length, errors: errors.length },
  })
}

const watcher = createChangeLogWatcher({
  name: 'shippedCostWatcher',
  intervalMs: POLL_MS,
  tables: 'order_items',
  batchSize: BATCH,
  isEnabled: () => isSystemAutomationActive(AUTOMATION_ID),
  onRows: async (rows, { advance }) => {
    if (!rows.length) return 0
    const matcher = loadMatcher()
    const seen = new Set()
    const frozen = []
    const errors = []
    for (const row of rows) {
      advance(row.id)
      if (seen.has(row.record_id)) continue
      seen.add(row.record_id)
      try {
        if (!matcher.match(row.record_id)) continue
        const r = freezeShippedTotalCost(row.record_id)
        if (r.status === 'frozen') frozen.push(r)
      } catch (e) {
        errors.push(`${row.record_id}: ${e.message}`)
      }
    }
    logPass(frozen, errors)
    return frozen.length
  },
})

export const pollOnce = watcher.pollOnce

export function startShippedCostWatcher() { watcher.start() }
export function stopShippedCostWatcher() { watcher.stop() }
