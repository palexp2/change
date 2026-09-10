/**
 * 053 — sync_log : accepter les déclencheurs du write-back ERP → Airtable.
 *
 * `sync_log.trigger` était contraint à ('webhook','manual','scheduled'), alors
 * que tout le write-back trace ses passes sous 'erp-writeback' et 'erp-create'
 * (services/airtableWriteback.js, routes/shipments.js…). Chaque INSERT échouait
 * donc sur le CHECK, et logSync avalait l'erreur dans un console.error :
 *
 *   syncLog write error: CHECK constraint failed: trigger IN ('webhook','manual','scheduled')
 *
 * Conséquence : AUCUNE poussée ERP → Airtable n'apparaissait dans l'historique
 * des syncs — ni ses succès, ni ses échecs. C'est précisément ce qu'on cherchait
 * en constatant qu'un numéro de suivi acheté dans Boréal n'était jamais arrivé
 * sur Airtable (signalement du 2026-09-10) : la panne était muette.
 *
 * Rebuild de table (SQLite ne sait pas élargir un CHECK) — sans risque ici :
 * sync_log est un journal glissant de 7 jours, sans clé étrangère entrante.
 */
export const id = '053-sync-log-erp-triggers'
export const description = "sync_log accepte les déclencheurs 'erp-writeback' et 'erp-create'"

export function up(db) {
  const hasNarrowCheck = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='sync_log' AND sql LIKE '%''webhook'',''manual'',''scheduled''%'
  `).get()
  if (!hasNarrowCheck) return

  db.exec(`
    CREATE TABLE sync_log_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('webhook','manual','scheduled','erp-writeback','erp-create')),
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      records_modified INTEGER DEFAULT 0,
      records_destroyed INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO sync_log_new (id, module, trigger, status, records_modified, records_destroyed, error_message, duration_ms, created_at)
      SELECT id, module, trigger, status, records_modified, records_destroyed, error_message, duration_ms, created_at FROM sync_log;
    DROP TABLE sync_log;
    ALTER TABLE sync_log_new RENAME TO sync_log;
    CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_log_module ON sync_log(module, created_at);
  `)
}
