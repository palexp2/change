// change_log : journal universel des mutations sur les tables opérationnelles.
//
// Pourquoi : le client maintient un cache complet de l'état (voir
// client/src/lib/dataStore.js). Pour rester cohérent il a besoin de connaître
// toutes les mutations, peu importe leur origine — route HTTP, sync Airtable,
// webhook Stripe, sync Gmail, etc. Plutôt que d'instrumenter chaque endroit
// (50+ trous identifiés), on pose des triggers AFTER INSERT/UPDATE/DELETE sur
// chaque table cachée qui inscrivent automatiquement la mutation dans
// change_log. Le client polle /api/bootstrap/delta?since=<ts> pour récupérer
// les changements depuis sa dernière synchro.
//
// Les triggers sont idempotents (CREATE TRIGGER IF NOT EXISTS) et tournent
// sur toutes les transactions SQLite, y compris celles ouvertes par les
// services Airtable/QB/Gmail — donc la couverture est exhaustive par
// construction.

import db from './database.js'
import { isSnapshotKept } from './snapshotFields.js'

// Liste des tables JOURNALISÉES dans change_log. L'ordre n'a pas d'importance.
// idColumn : nom de la PK (toutes les tables ERP utilisent 'id', TEXT/UUID).
// exclude : colonnes lourdes à *ne pas* envoyer dans le snapshot (chargées à la demande via les routes existantes).
// client : false = journalisée mais PAS envoyée au cache du navigateur.
//
// Journaliser et mettre en cache sont deux choses différentes. Des watchers
// serveur (adresses → vérificateur d'adresses, return_items → retours,
// order_items → coût d'envoi) lisent change_log en continu : leurs triggers
// doivent vivre. Mais aucune page ne lit ces tables-là dans le cache du
// navigateur — au 2026-09-03, les cinq marquées `client: false` pesaient 12,6 Mo
// des 42 Mo du snapshot, téléchargés et tenus à jour toutes les 10 s pour rien.
// Le jour où une page en a besoin, il suffit de retirer le drapeau.
export const CACHED_TABLES = [
  { name: 'companies',                idColumn: 'id', exclude: [] },
  { name: 'contacts',                 idColumn: 'id', exclude: [] },
  { name: 'products',                 idColumn: 'id', exclude: ['tech_info_fields'] },
  { name: 'projects',                 idColumn: 'id', exclude: [] },
  { name: 'orders',                   idColumn: 'id', exclude: [] },
  { name: 'order_items',              idColumn: 'id', exclude: [] },
  { name: 'factures',                 idColumn: 'id', exclude: [] },
  { name: 'tickets',                  idColumn: 'id', exclude: ['description', 'response'] },
  { name: 'tasks',                    idColumn: 'id', exclude: [] },
  { name: 'shipments',                idColumn: 'id', exclude: [] },
  { name: 'adresses',                 idColumn: 'id', exclude: [], client: false },
  { name: 'employees',                idColumn: 'id', exclude: [] },
  { name: 'vacations',                idColumn: 'id', exclude: [] },
  { name: 'paies',                    idColumn: 'id', exclude: ['csv'] },
  { name: 'timesheets',               idColumn: 'id', exclude: [] },
  { name: 'hour_bank',                idColumn: 'id', exclude: [] },
  { name: 'serial_numbers',           idColumn: 'id', exclude: [] },
  { name: 'stock_movements',          idColumn: 'id', exclude: [], client: false },
  { name: 'returns',                  idColumn: 'id', exclude: [] },
  { name: 'return_items',             idColumn: 'id', exclude: [], client: false },
  { name: 'purchases',                idColumn: 'id', exclude: [] },
  { name: 'achats_fournisseurs',      idColumn: 'id', exclude: ['lines'], client: false },
  { name: 'sale_receipts',            idColumn: 'id', exclude: ['raw_data'] },
  { name: 'journal_entries',          idColumn: 'id', exclude: [] },
  { name: 'interactions',             idColumn: 'id', exclude: [], client: false },
  { name: 'stripe_invoice_items',     idColumn: 'id', exclude: [] },
  { name: 'users',                    idColumn: 'id', exclude: ['password_hash'] },
]

function tableExists(name) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name)
  return !!row
}

export function initChangeLog() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('upsert','delete')),
      changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_change_log_changed_at ON change_log(changed_at);
    CREATE INDEX IF NOT EXISTS idx_change_log_table_record ON change_log(table_name, record_id);
  `)

  for (const t of CACHED_TABLES) {
    if (!tableExists(t.name)) {
      // La table n'existe pas encore (ex. nouvelle install) — skip silencieusement.
      continue
    }
    const id = t.idColumn

    // AFTER INSERT — nouveau record.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chl_${t.name}_ins
      AFTER INSERT ON ${t.name}
      BEGIN
        INSERT INTO change_log (table_name, record_id, change_type)
        VALUES ('${t.name}', NEW.${id}, 'upsert');
      END;
    `)

    // AFTER UPDATE — record modifié (y compris soft-delete via deleted_at).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chl_${t.name}_upd
      AFTER UPDATE ON ${t.name}
      BEGIN
        INSERT INTO change_log (table_name, record_id, change_type)
        VALUES ('${t.name}', NEW.${id}, 'upsert');
      END;
    `)

    // AFTER DELETE — hard delete (rare en prod, mais on capture quand même).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chl_${t.name}_del
      AFTER DELETE ON ${t.name}
      BEGIN
        INSERT INTO change_log (table_name, record_id, change_type)
        VALUES ('${t.name}', OLD.${id}, 'delete');
      END;
    `)
  }

  purgeChangeLog()

  console.log(`[change_log] initialized for ${CACHED_TABLES.filter(t => tableExists(t.name)).length} tables`)
}

// Rétention : 48 h. Au-delà, un client ne peut plus rattraper par delta — le
// serveur lui répond 410 et il refait un bootstrap complet.
export const CHANGE_LOG_RETENTION_HOURS = 48

// Purge des entrées hors rétention.
//
// Ne tournait qu'au démarrage, ce qui suffisait tant que le serveur redémarrait
// toutes les heures. Depuis que deploy.sh ne redémarre plus que lorsque
// `server/src` a changé, la purge doit avoir son propre battement : sinon
// change_log gonfle indéfiniment et ralentit tout ce qui le lit (delta,
// watchers). Appelée périodiquement depuis index.js.
export function purgeChangeLog() {
  try {
    const r = db.prepare(`
      DELETE FROM change_log
      WHERE changed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    `).run(`-${CHANGE_LOG_RETENTION_HOURS} hours`)
    if (r.changes > 0) {
      console.log(`[change_log] purged ${r.changes} entries older than ${CHANGE_LOG_RETENTION_HOURS}h`)
    }
    return r.changes
  } catch (e) {
    console.error('[change_log] purge failed', e)
    return 0
  }
}

// Cache des colonnes par table (lu une fois au boot via PRAGMA).
let columnsCache = null

// Relation de LECTURE d'une table cachée : la VUE `<table>_v` si elle existe.
// Load-bearing : la vue expose, en plus des colonnes physiques, les champs
// custom calculés (formule / lookup / rollup / link / created_by…). Sans elle,
// le snapshot n'envoyait QUE les colonnes physiques et toute page alimentée par
// le cache client (dataStore) affichait ces champs vides — une formule correcte
// semblait ne rien calculer. Équivalent de readRelation() (services/
// customFieldsView.js), dupliqué ici en 3 lignes pour éviter un import
// circulaire (customFieldsView → changeLog pour l'invalidation).
function readRelationName(name) {
  const v = `${name}_v`
  const hasView = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='view' AND name = ?`).get(v)
  return hasView ? v : name
}

// ─── Champs supprimés : hors du snapshot ──────────────────────────────────────
//
// La liste des exceptions et la règle vivent dans db/snapshotFields.js (module
// sans dépendance à la base, pour que le test de garde puisse le lire seul).

// Colonnes à retirer du snapshot pour une table : champs supprimés (corbeille)
// et champs purgés, moins les exceptions de snapshotFields.js.
export function droppedFieldColumns(tableName, idColumn = 'id') {
  const out = new Set()
  const add = (c) => { if (c && !isSnapshotKept(tableName, c, idColumn)) out.add(c) }
  try {
    for (const r of db.prepare(
      `SELECT column_name FROM custom_fields WHERE erp_table = ? AND deleted_at IS NOT NULL`
    ).all(tableName)) add(r.column_name)
  } catch { /* table absente (install neuve) */ }
  try {
    for (const r of db.prepare(
      `SELECT column_name FROM purged_fields WHERE erp_table = ?`
    ).all(tableName)) add(r.column_name)
  } catch { /* migration 011 pas encore passée */ }
  return out
}

function buildColumnsCache() {
  const cache = {}
  for (const t of CACHED_TABLES) {
    // `client: false` : journalisée pour les watchers, jamais envoyée au navigateur.
    if (t.client === false) continue
    if (!tableExists(t.name)) continue
    const relation = readRelationName(t.name)
    const cols = db.prepare(`PRAGMA table_info(${relation})`).all().map(c => c.name)
    // Un champ ressuscité (restauré depuis la corbeille) revient dans le snapshot
    // au prochain invalidateColumnsCache() — la signature des colonnes change et
    // les clients refont un bootstrap complet, donc rien ne reste vide.
    const dropped = droppedFieldColumns(t.name, t.idColumn)
    const allowed = cols.filter(c => !t.exclude.includes(c) && !dropped.has(c))
    cache[t.name] = {
      idColumn: t.idColumn,
      // Relation à mettre dans le FROM des lectures de snapshot/delta.
      relation,
      columns: allowed,
      selectClause: allowed.map(c => `"${c}"`).join(', '),
      // Le cache client représente l'état *vivant*. Les tables à soft-delete
      // (deleted_at) doivent donc exclure les records supprimés du snapshot et
      // les émettre comme tombstones (delete) dans le delta — voir bootstrap.js.
      hasSoftDelete: cols.includes('deleted_at'),
    }
  }
  columnsCache = cache
}

// À appeler dès qu'une VUE `<table>_v` est (re)générée : ses colonnes ont pu
// changer (champ custom ajouté / supprimé / renommé), donc le cache de colonnes
// est périmé. Sans ça, un champ créé après le démarrage n'apparaîtrait dans le
// snapshot qu'au prochain redémarrage du serveur.
export function invalidateColumnsCache() {
  columnsCache = null
}

export function getCachedTableSpec(tableName) {
  if (!columnsCache) buildColumnsCache()
  return columnsCache[tableName] || null
}

export function getAllCachedTableSpecs() {
  if (!columnsCache) buildColumnsCache()
  return columnsCache
}
