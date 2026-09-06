/**
 * 001 — Index sur airtable_id et sur les clés étrangères déclarées.
 *
 * airtable_id. Le sync fait `SELECT id FROM <table> WHERE airtable_id=?` pour
 * CHAQUE record importé, afin de retrouver son jumeau local. Mesuré le
 * 2026-09-02, huit des tables mirroirées les plus larges n'avaient aucun index
 * dessus : `EXPLAIN QUERY PLAN` répondait `SCAN` là où les autres tables
 * répondaient `SEARCH … USING INDEX`. Un index UNIQUE plutôt qu'un simple index :
 * le sync suppose déjà l'unicité (un airtable_id = un record local), et vérifié
 * avant migration, les huit tables sont propres — aucun doublon. La contrainte
 * transforme donc une supposition tacite en garantie de la base. SQLite admet
 * plusieurs NULL dans un index UNIQUE, et ces tables portent des records créés
 * dans l'ERP sans jumeau Airtable (802 entreprises, 1 242 contacts…) : ils
 * restent parfaitement valides.
 *
 * Clés étrangères. SQLite n'indexe JAMAIS une clé étrangère automatiquement.
 * Sans index, deux choses balayent la table entière : la recherche des enfants
 * d'un parent, et la vérification d'intégrité lors d'un DELETE sur le parent
 * (`foreign_keys = ON` est actif, voir db/database.js). Le critère retenu est
 * volontairement mécanique plutôt qu'au jugé : toute FK DÉCLARÉE, sur une table
 * de plus de 1 000 lignes, sans index — 23 colonnes.
 */

export const id = '001-index-airtable-id-and-fks'
export const description = 'Index UNIQUE sur airtable_id (8 tables) + index sur 23 clés étrangères déclarées'

// Tables mirroirées dont airtable_id balayait la table entière.
const AIRTABLE_ID_TABLES = [
  'companies', 'contacts', 'projects', 'products',
  'order_items', 'shipments', 'orders', 'tickets',
]

// [table, colonne] — FK déclarées, non indexées, sur des tables de plus de
// 1 000 lignes (relevé du 2026-09-02).
const FK_INDEXES = [
  ['stock_movements', 'user_id'],
  ['interactions', 'user_id'],
  ['achats_fournisseurs', 'created_by'],
  ['serial_numbers', 'order_item_id'],
  ['serial_numbers', 'order_id'],
  ['transcription_jobs', 'call_id'],
  ['tasks', 'assigned_to'],
  ['factures', 'order_id'],
  ['factures', 'project_id'],
  ['order_items', 'return_id'],
  ['order_items', 'shipment_id'],
  ['order_items', 'product_id'],
  ['tickets', 'assigned_to'],
  ['tickets', 'contact_id'],
  ['bank_transactions', 'reconciled_by'],
  ['soumissions', 'contact_id'],
  ['soumissions', 'company_id'],
  ['adresses', 'contact_id'],
  ['projects', 'contact_id'],
  ['drive_inventory_items', 'decided_by'],
  ['bom_items', 'component_id'],
  ['sale_receipt_events', 'user_id'],
  ['shipments', 'address_id'],
]

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)
}

export function up(db) {
  for (const table of AIRTABLE_ID_TABLES) {
    // Défensif : une table absente (nouvelle installation partielle) ne doit pas
    // faire échouer la migration entière — l'index se posera au prochain
    // déploiement, une fois la table créée par schema.js.
    if (!tableExists(db, table) || !hasColumn(db, table, 'airtable_id')) continue
    const dup = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT airtable_id FROM ${table}
        WHERE airtable_id IS NOT NULL
        GROUP BY airtable_id HAVING COUNT(*) > 1
      )
    `).get().n
    if (dup > 0) {
      // Un doublon signale un vrai problème de sync, pas un détail d'index :
      // deux records locaux se disputent le même record Airtable et le sync en
      // met à jour un seul. On pose un index NON unique pour le gain de
      // performance, et on laisse une trace claire à traiter.
      console.warn(`⚠️  ${table}: ${dup} airtable_id en doublon — index non unique posé, à investiguer`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_airtable_id ON ${table}(airtable_id)`)
      continue
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_airtable_id ON ${table}(airtable_id)`)
  }

  for (const [table, column] of FK_INDEXES) {
    if (!tableExists(db, table) || !hasColumn(db, table, column)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`)
  }
}
