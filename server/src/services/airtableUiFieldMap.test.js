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
  CREATE TABLE airtable_module_config (
    module TEXT PRIMARY KEY, base_id TEXT, table_id TEXT, field_map TEXT, last_synced_at TEXT
  );
  -- Seules les colonnes lues par la reprise (PRAGMA table_info).
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, order_number INTEGER, company_id TEXT, project_id TEXT,
    status TEXT, priority TEXT, notes TEXT, is_subscription INTEGER, address_id TEXT,
    abonnement TEXT
  );
  CREATE TABLE assemblages (
    id TEXT PRIMARY KEY, product_id TEXT, qty_produced INTEGER,
    assembled_at TEXT, assembly_points INTEGER
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

// ── Assemblages : les trois clés « gérées en code » deviennent des champs ────

const { retireAssemblagesCoreFieldMap, ASSEMBLAGES_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

function seedAssemblagesConfig(fieldMap = {
  product: 'Produit', qty_produced: 'Quantités fabriqués', assembled_at: 'Date',
}) {
  db.prepare("DELETE FROM airtable_module_config WHERE module='assemblages'").run()
  db.prepare(`INSERT INTO airtable_module_config (module, base_id, table_id, field_map)
              VALUES ('assemblages', 'appTest', 'tblAsm', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

test('assemblages : les 3 clés cœur deviennent des mappings réglables, le blob est effacé', () => {
  reset()
  seedAssemblagesConfig()
  assert.deepEqual(retireAssemblagesCoreFieldMap(), { migrated: 3 })

  const rows = db.prepare(
    "SELECT column_name, airtable_field_name, options FROM airtable_field_mappings WHERE erp_table='assemblages' ORDER BY column_name"
  ).all()
  assert.deepEqual(rows.map(r => r.column_name), ['assembled_at', 'product_id', 'qty_produced'])
  const byCol = Object.fromEntries(rows.map(r => [r.column_name, r]))
  assert.equal(byCol.qty_produced.airtable_field_name, 'Quantités fabriqués')
  assert.equal(byCol.assembled_at.airtable_field_name, 'Date')
  // Le champ lien porte sa table ERP cible : le sync résout « Produit » en fiche.
  assert.equal(JSON.parse(byCol.product_id.options).link_target_table, 'products')
  // …et son type ERP, sans quoi /champs/assemblages prendrait « Produit » pour du
  // texte : le picker offrirait n'importe quel champ Airtable et n'exigerait plus
  // la table cible au remappage.
  assert.equal(JSON.parse(byCol.product_id.options).native_field_type, 'link')

  assert.equal(
    db.prepare("SELECT field_map FROM airtable_module_config WHERE module='assemblages'").get().field_map,
    null,
  )
  // Le sync relit le même field_map, depuis les mappings cette fois.
  const map = fieldMapFromUi('assemblages', ASSEMBLAGES_FIELD_MAP_PLAN)
  assert.deepEqual(map, {
    product: 'Produit', qty_produced: 'Quantités fabriqués', assembled_at: 'Date',
  })
})

test('assemblages : aucun sens « both » semé (module en import seul)', () => {
  reset()
  seedAssemblagesConfig()
  retireAssemblagesCoreFieldMap()
  const dirs = db.prepare("SELECT COUNT(*) c FROM airtable_field_directions WHERE module='assemblages'").get()
  assert.equal(dirs.c, 0)
})

test('assemblages : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedAssemblagesConfig()
  retireAssemblagesCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE column_name='assembled_at'").run()
  assert.deepEqual(retireAssemblagesCoreFieldMap(), { migrated: 0 })
  // Un champ démappé par l'utilisateur ne revient pas.
  assert.equal(fieldMapFromUi('assemblages', ASSEMBLAGES_FIELD_MAP_PLAN).assembled_at, undefined)
})

test('assemblages : le type du lien « Produit » est reposé sur une reprise déjà faite', () => {
  reset()
  seedAssemblagesConfig()
  retireAssemblagesCoreFieldMap()
  // État de la prod avant ce correctif : la ligne existe, sans son type ERP.
  db.prepare(`UPDATE airtable_field_mappings SET options='{"link_target_table":"products"}'
              WHERE erp_table='assemblages' AND column_name='product_id'`).run()
  assert.deepEqual(retireAssemblagesCoreFieldMap(), { migrated: 0 })
  const opts = JSON.parse(db.prepare(
    "SELECT options FROM airtable_field_mappings WHERE erp_table='assemblages' AND column_name='product_id'"
  ).get().options)
  assert.equal(opts.native_field_type, 'link')
  assert.equal(opts.link_target_table, 'products')
})

// ── Produits (module « pieces ») ─────────────────────────────────────────────
// Le cas le plus fourni : 17 clés, dont 11 avaient déjà une ligne de mapping
// posée par ensureNativeFieldDefs (`native_*`, une whitelist interne, PAS un
// vrai mapping). La reprise doit se les approprier — sans quoi le picker de
// /champs/products continuerait de les ignorer et l'import perdrait tout.
const { retirePiecesCoreFieldMap, PIECES_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE products (
    id TEXT PRIMARY KEY, name_fr TEXT, name_en TEXT, sku TEXT, type TEXT,
    unit_cost REAL, price_cad REAL, stock_qty INTEGER, min_stock INTEGER,
    supplier TEXT, procurement_type TEXT, weight_lbs REAL, image_url TEXT,
    assembly_status REAL, finished_min_stock INTEGER, projected_available_qty INTEGER,
    producible_qty INTEGER, supplier_link TEXT
  );
`)

const PIECES_CORE_MAP = {
  name_fr: 'Nom', name_en: 'Nom anglais', sku: 'SKU', type: 'Type',
  unit_cost: 'Coût unitaire (FIFO)', price_cad: 'Prix client (CAD)', image: 'Image',
  stock_qty: 'Quantité en inventaire', min_stock: 'Inventaire minimum',
  supplier: 'Fournisseur préféré', procurement_type: 'Type de procurement',
  weight_lbs: 'poid (lbs)', projected_available_qty: 'Quantité sera disponible',
  producible_qty: 'Nombre de produits possibles', assembly_status: "Statut d'assemblage",
  finished_min_stock: 'Seuil min. produits finis', supplier_link: 'Lien fournisseur',
}

function seedPiecesConfig(fieldMap = PIECES_CORE_MAP) {
  db.prepare("DELETE FROM airtable_module_config WHERE module='pieces'").run()
  db.prepare(`INSERT INTO airtable_module_config (module, base_id, table_id, field_map)
              VALUES ('pieces', 'appTest', 'tblPieces', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

// La whitelist interne : une def par colonne native, dont l'`airtable_field_name`
// est un LIBELLÉ ERP (« Coût unitaire ») et non le vrai champ Airtable.
function seedNativeDefs(columns) {
  for (const [i, col] of columns.entries()) {
    db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
                VALUES (?, 'pieces', 'products', ?, ?, ?, '{"native_field_type":"text"}')`)
      .run(`nat${i}`, `native_${col}`, `Libellé ERP ${col}`, col)
  }
}

test('produits : les 17 clés cœur deviennent des mappings réglables, le blob est effacé', () => {
  reset()
  seedPiecesConfig()
  assert.deepEqual(retirePiecesCoreFieldMap(), { migrated: 17 })

  assert.equal(
    db.prepare("SELECT field_map FROM airtable_module_config WHERE module='pieces'").get().field_map,
    null,
  )
  // Le sync relit exactement le même field_map, depuis les mappings cette fois.
  assert.deepEqual(fieldMapFromUi('products', PIECES_FIELD_MAP_PLAN), PIECES_CORE_MAP)
  // L'image : clé `image` → colonne `image_url`, la seule dont les noms diffèrent.
  const img = db.prepare(
    "SELECT airtable_field_name, options FROM airtable_field_mappings WHERE erp_table='products' AND column_name='image_url'"
  ).get()
  assert.equal(img.airtable_field_name, 'Image')
  assert.equal(JSON.parse(img.options).format, 'url')
})

test('produits : une def « native_ » est reprise, pas doublée', () => {
  reset()
  seedNativeDefs(['name_fr', 'sku', 'unit_cost'])
  seedPiecesConfig()
  retirePiecesCoreFieldMap()

  const rows = db.prepare(
    "SELECT column_name, airtable_field_id, airtable_field_name FROM airtable_field_mappings WHERE erp_table='products' AND column_name IN ('name_fr','sku','unit_cost') ORDER BY column_name"
  ).all()
  assert.equal(rows.length, 3, 'une seule ligne par colonne (UNIQUE erp_table, column_name)')
  const byCol = Object.fromEntries(rows.map(r => [r.column_name, r]))
  // Le vrai nom du champ Airtable remplace le libellé ERP de la whitelist.
  assert.equal(byCol.unit_cost.airtable_field_name, 'Coût unitaire (FIFO)')
  assert.equal(byCol.unit_cost.airtable_field_id, 'core_unit_cost')
  // …et la def cesse d'être ignorée par la reconstruction du field_map.
  assert.equal(fieldMapFromUi('products', PIECES_FIELD_MAP_PLAN).unit_cost, 'Coût unitaire (FIFO)')
})

test('produits : aucun sens « both » semé (module en import seul)', () => {
  reset()
  seedPiecesConfig()
  retirePiecesCoreFieldMap()
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM airtable_field_directions WHERE module='pieces'").get().c,
    0,
  )
})

test('produits : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedPiecesConfig()
  retirePiecesCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='products' AND column_name='supplier_link'").run()
  assert.deepEqual(retirePiecesCoreFieldMap(), { migrated: 0 })
  // Un champ démappé depuis /champs/products ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('products', PIECES_FIELD_MAP_PLAN).supplier_link, undefined)
})

// ── Paies : premier module à la fois importé ET réécrit vers Airtable ────────
// La reprise doit donc semer les sens de write-back, sinon les modifications
// faites dans l'ERP cesseraient de repartir vers Airtable, en silence.
const { retirePaiesCoreFieldMap, PAIES_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE paies (
    id TEXT PRIMARY KEY, number INTEGER, period_start TEXT, period_end TEXT,
    status TEXT, csv TEXT, nb_holiday_days INTEGER, total_with_charges_and_reimb REAL,
    timesheets_deadline TEXT, timesheets_sent INTEGER, includes_hourly INTEGER,
    includes_mileage INTEGER, includes_expense_reimb INTEGER, includes_paid_leave INTEGER,
    includes_holiday_hours INTEGER, includes_sales_commissions INTEGER
  );
`)

const PAIES_CORE_MAP = {
  number: 'Number',
  period_end: 'Fin',
  status: 'Statut des feuilles de temps',
  csv: 'csv',
  nb_holiday_days: 'Nombre de congés fériés',
  total_with_charges_and_reimb: 'Total de la paie incluant les remises aux organismes et les remboursements de dépenses',
  timesheets_deadline: 'Date limite pour correction des feuille de temps',
  includes_hourly: "Heures pour employés payés à l'heure",
  includes_mileage: 'Kilométrage',
  includes_expense_reimb: 'Remboursement de dépenses',
  includes_paid_leave: 'Congés payés',
  includes_holiday_hours: 'Heures férié',
  includes_sales_commissions: 'Commissions vendeurs',
  timesheets_sent: 'Envoi des feuilles de temps',
  period_range: 'Période de paie',
}

function seedPaiesConfig(fieldMap = PAIES_CORE_MAP) {
  db.prepare("DELETE FROM airtable_module_config WHERE module='paies'").run()
  db.prepare(`INSERT INTO airtable_module_config (module, base_id, table_id, field_map)
              VALUES ('paies', 'appTest', 'tblPaie', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

test('paies : les 13 clés cœur deviennent des mappings réglables, le blob est effacé', () => {
  reset()
  seedPaiesConfig()
  assert.deepEqual(retirePaiesCoreFieldMap(), { migrated: 13 })

  assert.equal(
    db.prepare("SELECT field_map FROM airtable_module_config WHERE module='paies'").get().field_map,
    null,
  )
  // `csv` et `period_range` sont sorties du plan (migration 051) : même si le
  // blob historique les nommait encore, aucune ligne de mapping n'est créée.
  const { csv: _csv, period_range: _period_range, ...expected } = PAIES_CORE_MAP
  assert.deepEqual(fieldMapFromUi('paies', PAIES_FIELD_MAP_PLAN), expected)
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) n FROM airtable_field_mappings WHERE erp_table='paies' AND column_name IN ('csv','period_start')"
    ).get().n,
    0,
  )
})

test('paies : les colonnes modifiées dans l’ERP repartent en bidirectionnel', () => {
  reset()
  seedPaiesConfig()
  retirePaiesCoreFieldMap()
  const dirs = db.prepare(
    "SELECT field_key FROM airtable_field_directions WHERE module='paies' AND direction='both' ORDER BY field_key"
  ).all().map(r => r.field_key)
  assert.equal(dirs.length, 13)
  assert.ok(dirs.includes('dyn:status'))
  assert.ok(dirs.includes('dyn:total_with_charges_and_reimb'))
  // `csv` et `period_start` ne sont même plus des clés du plan (migration 051) :
  // aucune ligne dynamique ne peut exister pour elles.
  assert.ok(!dirs.includes('dyn:csv'))
  assert.ok(!dirs.includes('dyn:period_start'))
})

test('paies : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedPaiesConfig()
  retirePaiesCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='paies' AND column_name='status'").run()
  assert.deepEqual(retirePaiesCoreFieldMap(), { migrated: 0 })
  // Un champ démappé depuis /champs/paies ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('paies', PAIES_FIELD_MAP_PLAN).status, undefined)
})

// ── Contacts : le field_map cœur vit dans le singleton du CRM ────────────────
// Seul module dont le blob n'est pas dans airtable_module_config mais dans
// `airtable_sync_config.field_map_contacts` — la reprise doit lire et effacer
// LÀ, sinon les 6 champs resteraient annoncés « gérés en code » sur
// /champs/contacts au démarrage suivant.
const { retireContactsCoreFieldMap, CONTACTS_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE airtable_sync_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    base_id TEXT, contacts_table_id TEXT, companies_table_id TEXT,
    field_map_contacts TEXT, field_map_companies TEXT, last_synced_at TEXT
  );
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    email TEXT, phone TEXT, mobile TEXT, company_id TEXT, language TEXT, notes TEXT
  );
`)

const CONTACTS_CORE_MAP = {
  first_name: 'Prénom',
  last_name: 'Nom',
  email: 'Email',
  phone: 'Phone number',
  company: 'Entreprise',
  language: 'Langue',
}

function seedContactsConfig(fieldMap = CONTACTS_CORE_MAP) {
  db.prepare('DELETE FROM airtable_sync_config').run()
  db.prepare(`INSERT INTO airtable_sync_config (id, base_id, contacts_table_id, field_map_contacts)
              VALUES ('default', 'appTest', 'tblContacts', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

test('contacts : les 6 clés cœur deviennent des mappings réglables, le blob du CRM est effacé', () => {
  reset()
  seedContactsConfig()
  assert.deepEqual(retireContactsCoreFieldMap(), { migrated: 6 })

  assert.equal(
    db.prepare('SELECT field_map_contacts FROM airtable_sync_config').get().field_map_contacts,
    null,
  )
  assert.deepEqual(fieldMapFromUi('contacts', CONTACTS_FIELD_MAP_PLAN), CONTACTS_CORE_MAP)
})

test('contacts : « Entreprise » alimente la FK et porte sa table cible', () => {
  reset()
  seedContactsConfig()
  retireContactsCoreFieldMap()
  const company = db.prepare(
    "SELECT airtable_field_name, options FROM airtable_field_mappings WHERE erp_table='contacts' AND column_name='company_id'"
  ).get()
  assert.equal(company.airtable_field_name, 'Entreprise')
  assert.equal(JSON.parse(company.options).link_target_table, 'companies')
  // Courriel et téléphone disent ce qu'ils portent (saisie et picker de mapping).
  const email = db.prepare(
    "SELECT options FROM airtable_field_mappings WHERE erp_table='contacts' AND column_name='email'"
  ).get()
  assert.equal(JSON.parse(email.options).format, 'email')
})

test('contacts : aucun sens « both » semé (module sans write-back)', () => {
  reset()
  seedContactsConfig()
  retireContactsCoreFieldMap()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM airtable_field_directions WHERE module='airtable_contacts'").get().n,
    0,
  )
})

test('contacts : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedContactsConfig()
  retireContactsCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='contacts' AND column_name='language'").run()
  assert.deepEqual(retireContactsCoreFieldMap(), { migrated: 0 })
  // Un champ démappé depuis /champs/contacts ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('contacts', CONTACTS_FIELD_MAP_PLAN).language, undefined)
})

// ── Entreprises : mêmes singleton et mécanique que les contacts ─────────────
// Les 2 clés qui restaient (« Entreprise » → le nom, « Phase du cycle de vie »)
// après le drop des trois autres (migration 045). Particularité du cas réel :
// les deux colonnes portent DÉJÀ une ligne de mapping (jumelle dormante semée
// par le webhook) — la reprise doit alors la laisser faire foi sans rien
// migrer, et le field_map doit quand même être effacé.
const { retireCompaniesCoreFieldMap, COMPANIES_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle_phase TEXT, email TEXT,
    address TEXT, city TEXT, province TEXT, country TEXT, notes TEXT
  );
`)

const COMPANIES_CORE_MAP = { name: 'Entreprise', lifecycle_phase: 'Phase du cycle de vie' }

function seedCompaniesConfig(fieldMap = COMPANIES_CORE_MAP) {
  db.prepare('DELETE FROM airtable_sync_config').run()
  db.prepare(`INSERT INTO airtable_sync_config (id, base_id, companies_table_id, field_map_companies)
              VALUES ('default', 'appTest', 'tblCompanies', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

test('entreprises : les 2 clés cœur deviennent des mappings réglables, le blob du CRM est effacé', () => {
  reset()
  seedCompaniesConfig()
  assert.deepEqual(retireCompaniesCoreFieldMap(), { migrated: 2 })

  assert.equal(
    db.prepare('SELECT field_map_companies FROM airtable_sync_config').get().field_map_companies,
    null,
  )
  assert.deepEqual(fieldMapFromUi('companies', COMPANIES_FIELD_MAP_PLAN), COMPANIES_CORE_MAP)
  // « Entreprise » est une formule Airtable : le mapping le dit, pour que la
  // page ne la présente pas comme saisissable.
  const name = db.prepare(
    "SELECT options FROM airtable_field_mappings WHERE erp_table='companies' AND column_name='name'"
  ).get()
  assert.equal(JSON.parse(name.options).source, 'formula')
})

test('entreprises : une jumelle déjà en place fait foi (rien à migrer, blob effacé)', () => {
  reset()
  seedCompaniesConfig()
  // Cas de la vraie base : les deux colonnes ont leur ligne de mapping, posée
  // par l'import webhook et restée dormante tant que le field_map les nommait.
  for (const [column, field, id] of [['name', 'Entreprise', 'fldName'], ['lifecycle_phase', 'Phase du cycle de vie', 'fldPhase']]) {
    db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
                VALUES (?, 'airtable_companies', 'companies', ?, ?, ?, '{}')`).run(`m-${column}`, id, field, column)
  }
  assert.deepEqual(retireCompaniesCoreFieldMap(), { migrated: 0 })
  assert.equal(
    db.prepare('SELECT field_map_companies FROM airtable_sync_config').get().field_map_companies,
    null,
  )
  // Le mapping de l'utilisateur est intact : l'import continue de lire les
  // mêmes champs Airtable qu'avant le retrait.
  assert.deepEqual(fieldMapFromUi('companies', COMPANIES_FIELD_MAP_PLAN), COMPANIES_CORE_MAP)
  assert.equal(
    db.prepare("SELECT airtable_field_id FROM airtable_field_mappings WHERE erp_table='companies' AND column_name='name'").get().airtable_field_id,
    'fldName',
  )
})

test('entreprises : aucun sens « both » semé (module sans write-back)', () => {
  reset()
  seedCompaniesConfig()
  retireCompaniesCoreFieldMap()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM airtable_field_directions WHERE module='airtable_companies'").get().n,
    0,
  )
})

test('entreprises : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedCompaniesConfig()
  retireCompaniesCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='companies' AND column_name='lifecycle_phase'").run()
  assert.deepEqual(retireCompaniesCoreFieldMap(), { migrated: 0 })
  // Une phase démappée depuis /champs/companies ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('companies', COMPANIES_FIELD_MAP_PLAN).lifecycle_phase, undefined)
})

// ── Projets : les 2 derniers champs « gérés en code » ────────────────────────
// « ID » (le numéro de projet) et « Client final » (l'entreprise liée). Leurs
// deux colonnes avaient déjà une ligne `native_*` (whitelist interne) : la
// reprise doit se les approprier, sinon /champs/projects continuerait de les
// ignorer et l'import perdrait le nom — donc n'importerait plus AUCUN projet.
const { retireProjetsCoreFieldMap, PROJETS_FIELD_MAP_PLAN } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE airtable_projets_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    base_id TEXT, projects_table_id TEXT, field_map_projects TEXT
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT, company_id TEXT, contact_id TEXT
  );
`)

const PROJETS_CORE_MAP = { name: 'ID', company: 'Client final' }

function seedProjetsConfig(fieldMap = PROJETS_CORE_MAP) {
  db.prepare('DELETE FROM airtable_projets_config').run()
  db.prepare(`INSERT INTO airtable_projets_config (id, base_id, projects_table_id, field_map_projects)
              VALUES ('default', 'appTest', 'tblProjets', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

function seedProjetsNativeDefs() {
  for (const [col, label] of [['name', 'Projet'], ['company_id', 'Entreprise']]) {
    db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
                VALUES (?, 'projets', 'projects', ?, ?, ?, '{"native_field_type":"text"}')`)
      .run(`natp-${col}`, `native_${col}`, label, col)
  }
}

test('projets : « ID » et « Client final » deviennent des mappings réglables, le blob est effacé', () => {
  reset()
  seedProjetsNativeDefs()
  seedProjetsConfig()
  assert.deepEqual(retireProjetsCoreFieldMap(), { migrated: 2 })

  const rows = db.prepare(
    "SELECT column_name, airtable_field_id, airtable_field_name, options FROM airtable_field_mappings WHERE erp_table='projects' ORDER BY column_name"
  ).all()
  assert.equal(rows.length, 2, 'une seule ligne par colonne — la def native est reprise, pas doublée')
  const byCol = Object.fromEntries(rows.map(r => [r.column_name, r]))
  assert.equal(byCol.name.airtable_field_name, 'ID')
  assert.equal(byCol.name.airtable_field_id, 'core_name')
  assert.equal(byCol.company_id.airtable_field_name, 'Client final')
  // Le champ lien porte sa table ERP cible : sans elle, le sync stockerait des
  // record IDs Airtable bruts dans company_id.
  assert.equal(JSON.parse(byCol.company_id.options).link_target_table, 'companies')
  assert.equal(JSON.parse(byCol.company_id.options).native_field_type, 'link')
  // « ID » est une formule Airtable : la page ne doit pas le présenter comme saisissable.
  assert.equal(JSON.parse(byCol.name.options).source, 'formula')

  assert.equal(
    db.prepare('SELECT field_map_projects FROM airtable_projets_config').get().field_map_projects,
    null,
  )
  // Le sync relit exactement le même field_map, depuis les mappings cette fois.
  assert.deepEqual(fieldMapFromUi('projects', PROJETS_FIELD_MAP_PLAN), PROJETS_CORE_MAP)
})

test('projets : aucun sens « both » semé (formule + champ lien, rien à pousser)', () => {
  reset()
  seedProjetsConfig()
  retireProjetsCoreFieldMap()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM airtable_field_directions WHERE module='projets'").get().n,
    0,
  )
})

test('projets : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedProjetsConfig()
  retireProjetsCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='projects' AND column_name='company_id'").run()
  assert.deepEqual(retireProjetsCoreFieldMap(), { migrated: 0 })
  // Une entreprise démappée depuis /champs/projects ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('projects', PROJETS_FIELD_MAP_PLAN).company, undefined)
})

// ── Nomenclature (BOM) ──────────────────────────────────────────────────────
// Le module n'avait aucun contrôle de champ : /champs/bom_items n'offrait pas de
// colonne « Champ Airtable ». La reprise doit rendre ses 3 clés réglables sans
// changer d'un iota ce que le sync lit.
const { retireBomCoreFieldMap, BOM_FIELD_MAP_PLAN, ensureCoreMappingOptions } =
  await import('./airtableUiFieldMap.js')

db.exec(`
  CREATE TABLE bom_items (
    id TEXT PRIMARY KEY, product_id TEXT, component_id TEXT,
    qty_required REAL, ref_des TEXT
  );
`)

const BOM_CORE_MAP = {
  product: 'Produit', component: 'Pièces', qty_required: 'QTY nécessaires',
}

function seedBomConfig(fieldMap = BOM_CORE_MAP) {
  db.prepare("DELETE FROM airtable_module_config WHERE module='bom'").run()
  db.prepare(`INSERT INTO airtable_module_config (module, base_id, table_id, field_map)
              VALUES ('bom', 'appTest', 'tblBom', ?)`)
    .run(fieldMap === null ? null : JSON.stringify(fieldMap))
}

test('bom : les 3 clés cœur deviennent des mappings réglables, le blob est effacé', () => {
  reset()
  seedBomConfig()
  assert.deepEqual(retireBomCoreFieldMap(), { migrated: 3 })

  const rows = db.prepare(
    "SELECT column_name, airtable_field_id, airtable_field_name, options FROM airtable_field_mappings WHERE erp_table='bom_items' ORDER BY column_name"
  ).all()
  assert.deepEqual(rows.map(r => r.column_name), ['component_id', 'product_id', 'qty_required'])
  const byCol = Object.fromEntries(rows.map(r => [r.column_name, r]))
  assert.equal(byCol.product_id.airtable_field_id, 'core_product_id')
  // Les deux liens visent la table des produits : sans table cible, le sync
  // stockerait des record IDs Airtable bruts dans les colonnes.
  assert.equal(JSON.parse(byCol.product_id.options).link_target_table, 'products')
  assert.equal(JSON.parse(byCol.component_id.options).link_target_table, 'products')
  assert.equal(JSON.parse(byCol.product_id.options).native_field_type, 'link')
  // « Qté requise » est un nombre : sans ce type, le picker de /champs/bom_items
  // la prendrait pour du texte et n'offrirait aucun champ Airtable numérique.
  assert.equal(JSON.parse(byCol.qty_required.options).native_field_type, 'number')

  assert.equal(
    db.prepare("SELECT field_map FROM airtable_module_config WHERE module='bom'").get().field_map,
    null,
  )
  // Le sync relit exactement le même field_map, depuis les mappings cette fois.
  assert.deepEqual(fieldMapFromUi('bom_items', BOM_FIELD_MAP_PLAN), BOM_CORE_MAP)
})

test('bom : aucun sens « both » semé (module en import seul)', () => {
  reset()
  seedBomConfig()
  retireBomCoreFieldMap()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM airtable_field_directions WHERE module='bom'").get().n,
    0,
  )
})

test('bom : idempotence — un second démarrage ne re-migre rien', () => {
  reset()
  seedBomConfig()
  retireBomCoreFieldMap()
  db.prepare("DELETE FROM airtable_field_mappings WHERE erp_table='bom_items' AND column_name='qty_required'").run()
  assert.deepEqual(retireBomCoreFieldMap(), { migrated: 0 })
  // Une quantité démappée depuis /champs/bom_items ne ressuscite pas au démarrage.
  assert.equal(fieldMapFromUi('bom_items', BOM_FIELD_MAP_PLAN).qty_required, undefined)
})

test('rattrapage des options : reposées sur une reprise déjà faite, jamais sur un mapping utilisateur', () => {
  reset()
  seedBomConfig()
  retireBomCoreFieldMap()
  // Bascule déjà faite AVANT que le type soit déclaré : l'option manque.
  db.prepare("UPDATE airtable_field_mappings SET options='{}' WHERE column_name='qty_required'").run()
  // Mapping choisi par l'utilisateur sur une autre colonne : il ne nous appartient pas.
  db.prepare(`INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options)
              VALUES ('u-refdes', 'bom', 'bom_items', 'fldReal', 'Ref', 'ref_des', '{}')`).run()

  assert.deepEqual(ensureCoreMappingOptions('bom_items', {
    qty_required: { native_field_type: 'number' },
    ref_des: { native_field_type: 'text' },
  }), { fixed: 1 })

  const byCol = Object.fromEntries(db.prepare(
    "SELECT column_name, options FROM airtable_field_mappings WHERE erp_table='bom_items'"
  ).all().map(r => [r.column_name, JSON.parse(r.options || '{}')]))
  assert.equal(byCol.qty_required.native_field_type, 'number')
  assert.deepEqual(byCol.ref_des, {})
  // Deuxième passage : plus rien à corriger.
  assert.deepEqual(ensureCoreMappingOptions('bom_items', {
    qty_required: { native_field_type: 'number' },
  }), { fixed: 0 })
})

test('rattrapage des options : la table cible d’un lien n’est pas écrasée', () => {
  reset()
  seedBomConfig()
  retireBomCoreFieldMap()
  ensureCoreMappingOptions('bom_items', { product_id: { native_field_type: 'link' } })
  const opts = JSON.parse(db.prepare(
    "SELECT options FROM airtable_field_mappings WHERE erp_table='bom_items' AND column_name='product_id'"
  ).get().options)
  assert.equal(opts.link_target_table, 'products')
})
