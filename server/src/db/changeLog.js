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

// Liste des tables cachées côté client. L'ordre n'a pas d'importance.
// idColumn : nom de la PK (toutes les tables ERP utilisent 'id', TEXT/UUID).
// exclude : colonnes lourdes à *ne pas* envoyer dans le snapshot (chargées à la demande via les routes existantes).
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
  { name: 'adresses',                 idColumn: 'id', exclude: [] },
  { name: 'employees',                idColumn: 'id', exclude: [] },
  { name: 'vacations',                idColumn: 'id', exclude: [] },
  { name: 'paies',                    idColumn: 'id', exclude: ['csv'] },
  { name: 'timesheets',               idColumn: 'id', exclude: [] },
  { name: 'hour_bank',                idColumn: 'id', exclude: [] },
  { name: 'serial_numbers',           idColumn: 'id', exclude: [] },
  { name: 'stock_movements',          idColumn: 'id', exclude: [] },
  { name: 'returns',                  idColumn: 'id', exclude: [] },
  { name: 'return_items',             idColumn: 'id', exclude: [] },
  { name: 'purchases',                idColumn: 'id', exclude: [] },
  { name: 'achats_fournisseurs',      idColumn: 'id', exclude: ['lines'] },
  { name: 'sale_receipts',            idColumn: 'id', exclude: ['raw_data'] },
  { name: 'journal_entries',          idColumn: 'id', exclude: [] },
  { name: 'interactions',             idColumn: 'id', exclude: [] },
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

  // Purge des entrées > 48h — au-delà, le client doit faire un full re-bootstrap.
  // Tourne à chaque démarrage du serveur ; pas de cron supplémentaire nécessaire.
  try {
    const r = db.prepare(`
      DELETE FROM change_log
      WHERE changed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')
    `).run()
    if (r.changes > 0) console.log(`[change_log] purged ${r.changes} entries older than 48h`)
  } catch (e) {
    console.error('[change_log] purge failed', e)
  }

  console.log(`[change_log] initialized for ${CACHED_TABLES.filter(t => tableExists(t.name)).length} tables`)
}

// Cache des colonnes par table (lu une fois au boot via PRAGMA).
let columnsCache = null

function buildColumnsCache() {
  const cache = {}
  for (const t of CACHED_TABLES) {
    if (!tableExists(t.name)) continue
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all().map(c => c.name)
    const allowed = cols.filter(c => !t.exclude.includes(c))
    cache[t.name] = {
      idColumn: t.idColumn,
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

export function getCachedTableSpec(tableName) {
  if (!columnsCache) buildColumnsCache()
  return columnsCache[tableName] || null
}

export function getAllCachedTableSpecs() {
  if (!columnsCache) buildColumnsCache()
  return columnsCache
}
