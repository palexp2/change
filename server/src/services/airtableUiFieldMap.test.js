// Retrait du field_map « cœur » d'un module : reprise du mapping vers
// airtable_field_mappings (réglable dans /champs/:table) puis effacement du
// blob. La bascule est à USAGE UNIQUE et doit rester idempotente : un second
// démarrage ne doit ni re-migrer, ni re-supprimer un champ que l'utilisateur
// aurait restauré depuis la corbeille.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-uifieldmap-${process.pid}.db`)

const db = (await import('../db/database.js')).default

// schema.js n'est pas exécuté en test : on recrée les tables utilisées.
db.exec(`
  CREATE TABLE airtable_orders_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    base_id TEXT, orders_table_id TEXT, items_table_id TEXT,
    field_map_orders TEXT, field_map_items TEXT, last_synced_at TEXT
  );
  CREATE TABLE airtable_field_mappings (
    id TEXT PRIMARY KEY,
    module TEXT NOT NULL,
    erp_table TEXT NOT NULL,
    airtable_field_id TEXT,
    airtable_field_name TEXT,
    column_name TEXT NOT NULL,
    options TEXT DEFAULT '{}',
    import_disabled INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT,
    UNIQUE(erp_table, column_name)
  );
  CREATE TABLE airtable_field_directions (
    module TEXT NOT NULL, field_key TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'both',
    PRIMARY KEY (module, field_key)
  );
  CREATE TABLE custom_fields (
    id TEXT PRIMARY KEY, erp_table TEXT NOT NULL, name TEXT, column_name TEXT NOT NULL,
    type TEXT, kind TEXT DEFAULT 'data', source TEXT, deleted_at TEXT, updated_at TEXT
  );
  -- Seules les colonnes lues par la reprise (PRAGMA table_info).
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, order_number INTEGER, company_id TEXT, project_id TEXT,
    status TEXT, priority TEXT, notes TEXT, is_subscription INTEGER, address_id TEXT,
    abonnement TEXT
  );
`)

const CORE_MAP = {
  order_number: '# de commande',
  company: 'Client final',
  project: 'Projet',
  status: 'Statut',
  priority: 'Priorité',
  notes: 'Notes',
  is_subscription: 'Abonnement',
}

function seedOrdersConfig(fieldMap = CORE_MAP) {
  db.prepare('DELETE FROM airtable_orders_config').run()
  db.prepare(`INSERT INTO airtable_orders_config (id, base_id, orders_table_id, field_map_orders)
              VALUES ('default', 'appTest', 'tblTest', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

// Le doublon historique : le champ Airtable « Abonnement » mappé une seconde
// fois sur une colonne texte, jamais alimentée (le sync dynamique saute tout
// champ nommé dans le field_map cœur).
function seedAbonnementDuplicate() {
  db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
              VALUES ('dup', 'orders', 'orders', 'fldReal', 'Abonnement', 'abonnement', '{"choices":["Oui","Non"]}')`).run()
  db.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source)
              VALUES ('cfdup', 'orders', 'Abonnement', 'abonnement', 'single_select', 'data', 'airtable')`).run()
}

function reset() {
  db.prepare('DELETE FROM airtable_field_mappings').run()
  db.prepare('DELETE FROM airtable_field_directions').run()
  db.prepare('DELETE FROM custom_fields').run()
}

const { retireOrdersCoreFieldMap, fieldMapFromUi, ORDERS_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

test('reprise : les 7 clés cœur deviennent des lignes de mapping, et le blob est effacé', () => {
  reset()
  seedOrdersConfig()
  const { migrated } = retireOrdersCoreFieldMap()
  assert.equal(migrated, 7)

  const rows = db.prepare(
    "SELECT column_name, airtable_field_name, airtable_field_id, options FROM airtable_field_mappings WHERE erp_table='orders' ORDER BY column_name"
  ).all()
  assert.deepEqual(rows.map(r => r.column_name).sort(), [
    'company_id', 'is_subscription', 'notes', 'order_number', 'priority', 'project_id', 'status',
  ])
  // Le nom du champ Airtable est conservé tel quel : tous les chemins de sync
  // apparient par NOM, l'id `core_*` n'est qu'un jeton local.
  const byCol = Object.fromEntries(rows.map(r => [r.column_name, r]))
  assert.equal(byCol.status.airtable_field_name, 'Statut')
  assert.equal(byCol.status.airtable_field_id, 'core_status')
  assert.equal(byCol.is_subscription.airtable_field_name, 'Abonnement')

  // Blob effacé → plus aucun champ exclu du picker de /champs/orders.
  const cfg = db.prepare('SELECT field_map_orders FROM airtable_orders_config').get()
  assert.equal(cfg.field_map_orders, null)
})

test('les champs lien portent leur table ERP cible, les formules leur source', () => {
  reset()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()
  const opts = (col) => JSON.parse(db.prepare(
    "SELECT options FROM airtable_field_mappings WHERE erp_table='orders' AND column_name=?"
  ).get(col).options)

  assert.equal(opts('company_id').link_target_table, 'companies')
  assert.equal(opts('project_id').link_target_table, 'projects')
  // « Statut » et « # de commande » sont des FORMULES Airtable : la source
  // calculée les écarte du formulaire de création (formFieldCatalog).
  assert.equal(opts('status').source, 'formula')
  assert.equal(opts('order_number').source, 'formula')
  assert.equal(opts('notes').source, undefined)
})

test('seuls les champs réellement écrivables côté Airtable partent en bidirectionnel', () => {
  reset()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()
  const dirs = Object.fromEntries(db.prepare(
    "SELECT field_key, direction FROM airtable_field_directions WHERE module='orders'"
  ).all().map(r => [r.field_key, r.direction]))

  assert.equal(dirs['dyn:notes'], 'both')
  assert.equal(dirs['dyn:priority'], 'both')
  assert.equal(dirs['dyn:is_subscription'], 'both')
  // Champs formule : jamais poussés (un PATCH renverrait 422).
  assert.equal(dirs['dyn:status'], undefined)
  assert.equal(dirs['dyn:order_number'], undefined)
})

test('le doublon « Abonnement » part à la corbeille, la colonne qui porte la logique reste', () => {
  reset()
  seedAbonnementDuplicate()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()

  const dup = db.prepare("SELECT import_disabled FROM airtable_field_mappings WHERE column_name='abonnement'").get()
  assert.equal(dup.import_disabled, 1)
  const cf = db.prepare("SELECT deleted_at FROM custom_fields WHERE column_name='abonnement'").get()
  assert.ok(cf.deleted_at, 'le champ texte doublon doit être à la corbeille')
  // La colonne 0/1 reste mappée et active : c'est elle que lit le métier.
  const keep = db.prepare("SELECT import_disabled FROM airtable_field_mappings WHERE column_name='is_subscription'").get()
  assert.equal(keep.import_disabled, 0)
})

test('idempotence : un second démarrage ne re-migre rien et ne re-supprime rien', () => {
  reset()
  seedAbonnementDuplicate()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()

  // L'utilisateur restaure le doublon depuis la corbeille…
  db.prepare("UPDATE custom_fields SET deleted_at=NULL WHERE column_name='abonnement'").run()
  // …et le serveur redémarre : le blob est vide, la reprise ne fait plus rien.
  assert.deepEqual(retireOrdersCoreFieldMap(), { migrated: 0 })
  const cf = db.prepare("SELECT deleted_at FROM custom_fields WHERE column_name='abonnement'").get()
  assert.equal(cf.deleted_at, null, 'un champ restauré ne doit pas être re-supprimé')
})

test("un blob vide ('{}') est effacé sans déclencher le nettoyage à usage unique", () => {
  reset()
  seedAbonnementDuplicate()
  seedOrdersConfig({})
  assert.deepEqual(retireOrdersCoreFieldMap(), { migrated: 0 })
  const cf = db.prepare("SELECT deleted_at FROM custom_fields WHERE column_name='abonnement'").get()
  assert.equal(cf.deleted_at, null)
  assert.equal(db.prepare('SELECT field_map_orders FROM airtable_orders_config').get().field_map_orders, null)
})

test('un mapping déjà posé par l’utilisateur fait foi et n’est pas écrasé', () => {
  reset()
  db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
              VALUES ('mine', 'orders', 'orders', 'fldChoisiParMoi', 'Mes notes', 'notes', '{}')`).run()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()
  const row = db.prepare("SELECT airtable_field_name FROM airtable_field_mappings WHERE column_name='notes'").get()
  assert.equal(row.airtable_field_name, 'Mes notes')
})

test('fieldMapFromUi reconstruit le field_map attendu par le sync depuis les mappings', () => {
  reset()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()
  const map = fieldMapFromUi('orders', ORDERS_FIELD_MAP_PLAN)
  assert.equal(map.status, 'Statut')
  assert.equal(map.company, 'Client final')
  assert.equal(map.is_subscription, 'Abonnement')
  // `address` n'était pas mappée du temps du field_map : elle reste absente,
  // et le sync traite la clé comme non mappée au lieu d'écrire NULL.
  assert.equal(map.address, undefined)
})

test('un champ démappé disparaît du field_map reconstruit (au lieu d’écraser la colonne)', () => {
  reset()
  seedOrdersConfig()
  retireOrdersCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE column_name='status'").run()
  const map = fieldMapFromUi('orders', ORDERS_FIELD_MAP_PLAN)
  assert.equal(map.status, undefined)
})
