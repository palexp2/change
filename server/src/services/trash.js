// Corbeille (/admin/corbeille) — liste, restauration, purge manuelle et
// auto-nettoyage après N jours.
//
// Un seul endroit décrit les tables à soft-delete visibles dans la corbeille :
// la route /api/admin/trash, le bouton « Vider la corbeille » et le nettoyage
// automatique lisent tous cette liste, donc ils ne peuvent plus diverger.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { purgeFields } from './fieldPurge.js'

export const TRASH_AUTOMATION_ID = 'sys_trash_auto_cleanup'
export const DEFAULT_RETENTION_DAYS = 30

// `autoPurge: false` = visible et restaurable dans la corbeille, mais JAMAIS
// détruit automatiquement.
//
// custom_fields est le seul cas. Détruire une ligne de champ n'est pas un
// DELETE ordinaire (voir services/fieldPurge.js) : la colonne SQL d'un champ
// perso est droppée, ses valeurs sont perdues, et une pierre tombale
// permanente interdit au champ de revenir. C'est irréversible même depuis la
// corbeille — donc ça reste un geste explicite (« Vider la corbeille »),
// jamais une conséquence du calendrier.
export const TRASH_TABLES = [
  {
    key: 'custom_fields', table: 'custom_fields', label: 'Champs', autoPurge: false,
    // COALESCE : un champ natif supprimé sans avoir jamais été renommé n'a pas
    // de `name` — on retombe sur le nom de sa colonne plutôt qu'un libellé vide.
    sql: `SELECT id, (erp_table || ' / ' || COALESCE(NULLIF(name, ''), column_name)) as label, deleted_at FROM custom_fields WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    // Purge spécifique : DROP COLUMN + pierre tombale (fieldPurge.js).
    purge: purgeFields,
  },
  {
    key: 'companies', table: 'companies', label: 'Entreprises', autoPurge: true,
    sql: `SELECT id, name as label, deleted_at FROM companies WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'contacts', table: 'contacts', label: 'Contacts', autoPurge: true,
    sql: `SELECT id, (first_name || ' ' || last_name) as label, deleted_at FROM contacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'orders', table: 'orders', label: 'Commandes', autoPurge: true,
    sql: `SELECT id, ('Commande #' || order_number) as label, deleted_at FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'products', table: 'products', label: 'Produits', autoPurge: true,
    sql: `SELECT id, COALESCE(name_fr, name_en, sku) as label, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'shipments', table: 'shipments', label: 'Envois', autoPurge: true,
    sql: `SELECT s.id, COALESCE('Envoi #' || o.order_number, s.tracking_number, s.id) as label, s.deleted_at FROM shipments s LEFT JOIN orders o ON s.order_id=o.id WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`,
  },
  {
    key: 'returns', table: 'returns', label: 'Retours', autoPurge: true,
    sql: `SELECT id, COALESCE(n_de_retour, id) as label, deleted_at FROM returns WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'projects', table: 'projects', label: 'Projets', autoPurge: true,
    sql: `SELECT id, name as label, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'assemblages', table: 'assemblages', label: 'Assemblages', autoPurge: true,
    sql: `SELECT id, COALESCE(name, id) as label, deleted_at FROM assemblages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'tasks', table: 'tasks', label: 'Tâches', autoPurge: true,
    sql: `SELECT id, title as label, deleted_at FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
  {
    key: 'interactions', table: 'interactions', label: 'Interactions', autoPurge: true,
    sql: `SELECT i.id, COALESCE(e.subject, i.type) as label, i.deleted_at FROM interactions i LEFT JOIN emails e ON e.interaction_id=i.id WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC`,
  },
  {
    key: 'serial_numbers', table: 'serial_numbers', label: 'Numéros de série', autoPurge: true,
    sql: `SELECT id, serial as label, deleted_at FROM serial_numbers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
  },
]

// Tables à soft-delete qui ne s'affichent pas dans la corbeille (pas des
// enregistrements métier) mais qui suivent la même rétention.
const HIDDEN_AUTO_PURGE_TABLES = [
  { key: 'automations', table: 'automations', label: 'Automations', autoPurge: true },
]

export const TRASH_TABLE_KEYS = TRASH_TABLES.map(t => t.key)

function autoPurgeTargets() {
  return [...TRASH_TABLES, ...HIDDEN_AUTO_PURGE_TABLES].filter(t => t.autoPurge)
}

// Rétention et état lus sur l'automation système (modifiables depuis sa fiche).
export function trashCleanupConfig() {
  let row
  try { row = db.prepare('SELECT action_config, active FROM automations WHERE id=?').get(TRASH_AUTOMATION_ID) } catch { row = null }
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { cfg = {} }
  const days = Number(cfg.retention_days)
  return {
    retentionDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS,
    active: !!row?.active,
  }
}

// Contenu de la corbeille + la règle de rétention en vigueur, pour que la page
// puisse afficher « suppression définitive dans X jours » sur chaque élément.
export function listTrash() {
  const { retentionDays, active } = trashCleanupConfig()
  const tables = {}
  for (const t of TRASH_TABLES) {
    let items = []
    try { items = db.prepare(t.sql).all() } catch { items = [] }
    tables[t.key] = { label: t.label, auto_purge: t.autoPurge, items }
  }
  return { retention_days: retentionDays, auto_cleanup_active: active, tables }
}

// Suppression définitive, ligne par ligne : une clé étrangère qui retient un
// enregistrement ne doit pas emporter tout le lot avec elle (même prudence que
// purgeOrphansTolerant du moteur de miroir).
//
// `purge` sur l'entrée de table court-circuite le DELETE : certaines lignes
// demandent plus qu'un DELETE pour être vraiment détruites (un champ traîne une
// colonne SQL et une définition côté client — cf. fieldPurge.js).
function deleteRows(table, ids, purge) {
  if (purge) {
    const r = purge(ids)
    return { purged: r.purged, blocked: r.blocked }
  }
  const stmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
  let purged = 0
  const blocked = []
  for (const id of ids) {
    try { purged += stmt.run(id).changes }
    catch (e) { blocked.push({ id, error: e.message }) }
  }
  return { purged, blocked }
}

// Purge manuelle (bouton « Vider la corbeille ») — tout, sans condition d'âge.
export function purgeTrash() {
  let total = 0
  const blocked = []
  for (const t of TRASH_TABLES) {
    try {
      const ids = db.prepare(`SELECT id FROM ${t.table} WHERE deleted_at IS NOT NULL`).all().map(r => r.id)
      if (!ids.length) continue
      const r = deleteRows(t.table, ids, t.purge)
      total += r.purged
      blocked.push(...r.blocked.map(b => ({ ...b, table: t.key })))
    } catch (e) {
      // Table absente / sans deleted_at, ou purge spécifique en échec : on
      // continue les autres tables plutôt que de laisser la corbeille pleine.
      blocked.push({ table: t.key, error: e.message })
    }
  }
  return { purged: total, blocked: blocked.length, blocked_details: blocked.slice(0, 20) }
}

// Nettoyage automatique : détruit ce qui traîne dans la corbeille depuis plus
// de `retention_days` jours. `force` court-circuite l'interrupteur de
// l'automation (bouton « Exécuter » de sa fiche).
export function runTrashAutoCleanup({ dryRun = false, trigger = 'cron', force = false, log = true } = {}) {
  const t0 = Date.now()
  const { retentionDays, active } = trashCleanupConfig()
  if (!force && !active) {
    return { skipped: 'automation désactivée', retention_days: retentionDays, purged: 0, blocked: 0, details: [] }
  }

  // Format identique à celui écrit par strftime('%Y-%m-%dT%H:%M:%fZ') : la
  // comparaison de chaînes ISO est donc chronologique.
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()

  const details = []
  let purged = 0
  const blocked = []
  for (const t of autoPurgeTargets()) {
    let ids = []
    try {
      ids = db.prepare(
        `SELECT id FROM ${t.table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`
      ).all(cutoff).map(r => r.id)
    } catch (e) {
      details.push({ table: t.key, label: t.label, error: e.message })
      continue
    }
    if (!ids.length) continue
    if (dryRun) {
      details.push({ table: t.key, label: t.label, eligible: ids.length })
      purged += ids.length
      continue
    }
    const res = deleteRows(t.table, ids, t.purge)
    purged += res.purged
    blocked.push(...res.blocked.map(b => ({ ...b, table: t.key })))
    details.push({ table: t.key, label: t.label, purged: res.purged, blocked: res.blocked.length })
  }

  const summary = dryRun
    ? `${purged} élément(s) supprimable(s) définitivement (dans la corbeille depuis plus de ${retentionDays} jours) — rien détruit`
    : purged || blocked.length
      ? `${purged} élément(s) supprimé(s) définitivement après ${retentionDays} jours`
        + (blocked.length ? ` · ${blocked.length} retenu(s) par une référence` : '')
      : `Rien à supprimer (aucun élément dans la corbeille depuis plus de ${retentionDays} jours)`

  const out = {
    summary, retention_days: retentionDays, cutoff,
    purged, blocked: blocked.length, blocked_details: blocked.slice(0, 20), details,
  }

  // On ne journalise que les passages qui ont fait quelque chose : sinon un
  // passage quotidien vide noierait l'historique de l'automation. Un
  // enregistrement retenu par une référence n'est PAS une erreur — c'est le
  // garde-fou qui joue son rôle —, donc statut « success » avec le compte.
  if (log && !dryRun && (purged > 0 || blocked.length > 0)) {
    logSystemRun(TRASH_AUTOMATION_ID, {
      status: 'success',
      result: summary,
      duration_ms: Date.now() - t0,
      triggerData: { trigger },
    })
  }
  if (!dryRun && purged > 0) console.log(`🧹 corbeille : ${summary}`)
  return out
}

// Passage au démarrage — le serveur peut être resté éteint plusieurs jours.
export function runTrashAutoCleanupOnBoot() {
  try {
    if (!isSystemAutomationActive(TRASH_AUTOMATION_ID)) return
    runTrashAutoCleanup({ trigger: 'démarrage' })
  } catch (e) {
    console.warn('[corbeille] auto-nettoyage au démarrage :', e.message)
  }
}
