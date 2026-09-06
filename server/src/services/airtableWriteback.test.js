// Garde anti-boucle du write-back ERP → Airtable.
//
// Quand l'ERP pousse une modif vers Airtable (PATCH), Airtable renvoie un webhook
// d'« echo » de notre propre écriture. Sans garde, le sync entrant ré-applique
// cette valeur dans l'ERP → boucle infinie avec sys_airtable_webhook_router.
// recordWriteback() mémorise les champs poussés ; consumeWritebackEcho() reconnaît
// l'echo (mêmes valeurs, à usage unique, TTL borné) pour que le sync l'ignore.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// DB jetable — n'ouvre jamais la vraie erp.db.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-writeback-${process.pid}.db`)

const db = (await import('../db/database.js')).default
// schema.js n'est pas exécuté en test : on recrée les tables utilisées à l'identique.
db.exec(`CREATE TABLE IF NOT EXISTS airtable_writeback_guard (
  airtable_id TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  written_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_directions (
  module TEXT NOT NULL,
  field_key TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'both',
  PRIMARY KEY (module, field_key)
)`)

db.exec(`CREATE TABLE IF NOT EXISTS airtable_field_mappings (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  erp_table TEXT NOT NULL,
  airtable_field_id TEXT,
  airtable_field_name TEXT,
  column_name TEXT NOT NULL,
  options TEXT DEFAULT '{}',
  import_disabled INTEGER DEFAULT 0
)`)
db.exec(`CREATE TABLE IF NOT EXISTS airtable_frozen_columns (
  erp_table TEXT NOT NULL, column_name TEXT NOT NULL, PRIMARY KEY (erp_table, column_name)
)`)

db.exec(`CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  erp_table TEXT NOT NULL,
  name TEXT,
  column_name TEXT,
  type TEXT,
  kind TEXT DEFAULT 'data',
  deleted_at TEXT
)`)
// Table + vue des billets : la vue est ce qui donne une valeur aux champs
// calculés (cf. services/customFieldsView.js), donc ce qui les rend poussables.
db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, airtable_id TEXT, titre TEXT
)`)
db.exec(`DROP VIEW IF EXISTS tickets_v`)
db.exec(`CREATE VIEW tickets_v AS SELECT t.*, 'rec' || t.id AS cf_boreal_recordid FROM tickets t`)

const {
  recordWriteback, consumeWritebackEcho,
  setFieldDirection, dynamicFieldDirection, fieldMapDirection, writebackModuleForTable,
  airtableFieldValue, WRITEBACK_MODULES, buildColumnMap, pushableLinkColumn,
  pushOnlyColumns,
} = await import('./airtableWriteback.js')

test('echo reconnu : mêmes valeurs poussées puis reçues → ignoré par le sync', () => {
  recordWriteback('recEchoSame', { Statut: 'Reçu', 'Prix unitaire': 12.5 })
  assert.equal(consumeWritebackEcho('recEchoSame', { Statut: 'Reçu', 'Prix unitaire': 12.5 }), true)
})

test('garde à usage unique : un second webhook pour le même write n’est plus un echo', () => {
  recordWriteback('recOnce', { Notes: 'abc' })
  assert.equal(consumeWritebackEcho('recOnce', { Notes: 'abc' }), true)
  // Deuxième passage (ou vrai changement ultérieur) : plus de garde → le sync traite.
  assert.equal(consumeWritebackEcho('recOnce', { Notes: 'abc' }), false)
})

test('vrai changement Airtable après notre write → pas un echo, le sync l’applique', () => {
  recordWriteback('recChanged', { Statut: 'Commandé' })
  // Un humain a édité Airtable entre notre PATCH et le webhook : valeur différente.
  assert.equal(consumeWritebackEcho('recChanged', { Statut: 'Reçu' }), false)
})

test('typecast Airtable : nombre poussé revenant en chaîne reste un echo', () => {
  recordWriteback('recTypecast', { 'Qté commandée': 5 })
  assert.equal(consumeWritebackEcho('recTypecast', { 'Qté commandée': '5' }), true)
})

test('null poussé ⇄ champ absent/vide côté Airtable → echo (effacement répercuté)', () => {
  recordWriteback('recNull', { Notes: null })
  // Airtable omet les champs vides : le champ n'apparaît pas dans le webhook.
  assert.equal(consumeWritebackEcho('recNull', {}), true)
})

test('aucune garde enregistrée → jamais un echo', () => {
  assert.equal(consumeWritebackEcho('recUnknown', { Statut: 'Reçu' }), false)
})

test('garde périmée (TTL dépassé) → ignorée et nettoyée', () => {
  // written_at à 5 min ⇒ au-delà du GUARD_TTL_MS (2 min) : entrée périmée.
  db.prepare(`INSERT INTO airtable_writeback_guard (airtable_id, fields_json, written_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'))`)
    .run('recStale', JSON.stringify({ Statut: 'Reçu' }))
  assert.equal(consumeWritebackEcho('recStale', { Statut: 'Reçu' }), false)
  // L'entrée périmée doit avoir été supprimée.
  const left = db.prepare('SELECT 1 FROM airtable_writeback_guard WHERE airtable_id=?').get('recStale')
  assert.equal(left, undefined)
})

test('echo partiel : un seul champ poussé qui matche, autres champs Airtable ignorés', () => {
  recordWriteback('recPartial', { Statut: 'Reçu' })
  // Le webhook contient d'autres champs (gelés/non poussés) — seul le champ poussé compte.
  assert.equal(consumeWritebackEcho('recPartial', { Statut: 'Reçu', 'Champ gelé': 'xyz' }), true)
})

// ── Sens de sync des champs dynamiques (clés `dyn:<colonne>`) ────────────────

test('champ dynamique : défaut pull (jamais poussé) sur un module write-back', () => {
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'pull')
})

test('champ dynamique : module sans write-back → toujours pull', () => {
  assert.equal(dynamicFieldDirection('pieces', 'cf_commentaire'), 'pull')
  assert.equal(dynamicFieldDirection(null, 'cf_commentaire'), 'pull')
})

test('setFieldDirection accepte une clé dyn: sur un module write-back et persiste', () => {
  setFieldDirection('achats', 'dyn:cf_commentaire', 'both')
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'both')
  setFieldDirection('achats', 'dyn:cf_commentaire', 'push')
  assert.equal(dynamicFieldDirection('achats', 'cf_commentaire'), 'push')
  // La clé cœur homonyme n'est pas affectée par l'override dyn:.
  assert.equal(fieldMapDirection('achats', 'cf_commentaire'), 'both')
})

test('setFieldDirection refuse une clé dyn: sur un module sans write-back', () => {
  assert.throws(() => setFieldDirection('pieces', 'dyn:cf_x', 'both'), /ne supporte pas/)
})

test('setFieldDirection refuse toujours une clé cœur non configurable (skipKeys)', () => {
  assert.throws(() => setFieldDirection('achats', 'product', 'both'), /ne supporte pas/)
})

test('writebackModuleForTable : table ERP → clé module write-back', () => {
  assert.equal(writebackModuleForTable('purchases'), 'achats')
  assert.equal(writebackModuleForTable('shipments'), 'envois')
  assert.equal(writebackModuleForTable('products'), null)
})

// ── Lignes de commande : le sens du produit est CHOISISSABLE, pas actif d'office ──

test('order_items : défaut pull — déclarer le module ne pousse rien tant qu’on n’a rien choisi', () => {
  assert.equal(fieldMapDirection('order_items', 'product'), 'pull')
  assert.equal(fieldMapDirection('order_items', 'qty'), 'pull')
})

test('order_items : le produit accepte le bidirectionnel', () => {
  setFieldDirection('order_items', 'product', 'both')
  assert.equal(fieldMapDirection('order_items', 'product'), 'both')
  // Retour au sens d'origine : les autres clés ne bougent pas avec.
  setFieldDirection('order_items', 'product', 'pull')
  assert.equal(fieldMapDirection('order_items', 'product'), 'pull')
  assert.equal(fieldMapDirection('order_items', 'qty'), 'pull')
})

test('order_items : la commande liée et le coût unitaire (lookup Airtable) restent verrouillés', () => {
  assert.throws(() => setFieldDirection('order_items', 'order', 'both'), /ne supporte pas/)
  assert.throws(() => setFieldDirection('order_items', 'unit_cost', 'both'), /ne supporte pas/)
  assert.equal(fieldMapDirection('order_items', 'order'), 'pull')
  assert.equal(fieldMapDirection('order_items', 'unit_cost'), 'pull')
})

test('writebackModuleForTable connaît la table des lignes de commande', () => {
  assert.equal(writebackModuleForTable('order_items'), 'order_items')
})

// ── Commandes : plus de mapping cœur, donc plus de sens verrouillé ───────────
//
// Le field_map de `orders` a été retiré (retireOrdersCoreFieldMap) : tous les
// scalaires passent par le chemin dynamique, dont le sens est réglable champ
// par champ. Avant, `skipKeys` verrouillait 7 clés sur 8 en 'pull' — c'est ce
// qui rendait impossible un sync bidirectionnel sur « Abonnement ».

test('orders : le module déclare un plan de mapping issu de l’interface', () => {
  assert.equal(writebackModuleForTable('orders'), 'orders')
})

test('orders : le sens de l’abonnement est désormais configurable', () => {
  setFieldDirection('orders', 'dyn:is_subscription', 'both')
  assert.equal(dynamicFieldDirection('orders', 'is_subscription'), 'both')
  setFieldDirection('orders', 'dyn:is_subscription', 'pull')
  assert.equal(dynamicFieldDirection('orders', 'is_subscription'), 'pull')
})

test('orders : aucune clé cœur ne reste verrouillée en pull par skipKeys', () => {
  for (const key of ['is_subscription', 'priority', 'notes', 'status', 'order_number']) {
    assert.doesNotThrow(() => setFieldDirection('orders', key, 'both'), `clé ${key}`)
  }
})

// ── Codec de valeur : ce qui part réellement vers Airtable ──────────────────
//
// Le champ Airtable « Abonnement » n'est PAS une case à cocher : c'est un
// singleSelect Oui/Non. La colonne ERP, elle, est un 0/1 (toute la logique
// métier compte dessus). Sans traduction, Airtable reçoit un entier et rejette
// l'écriture — c'est ce qui rendait le bidirectionnel inatteignable.

test('abonnement : 1 → « Oui », 0 → « Non » (singleSelect, pas une case à cocher)', () => {
  const cfg = WRITEBACK_MODULES.orders
  assert.equal(airtableFieldValue(cfg, 'is_subscription', 1), 'Oui')
  assert.equal(airtableFieldValue(cfg, 'is_subscription', 0), 'Non')
})

test('abonnement : null reste null — on efface le champ, on ne traduit pas le vide', () => {
  assert.equal(airtableFieldValue(WRITEBACK_MODULES.orders, 'is_subscription', null), null)
})

test('une colonne sans codec part telle quelle, undefined ramené à null', () => {
  const cfg = WRITEBACK_MODULES.orders
  assert.equal(airtableFieldValue(cfg, 'notes', 'Livrer avant 9 h'), 'Livrer avant 9 h')
  assert.equal(airtableFieldValue(cfg, 'notes', undefined), null)
})

test('les cases à cocher restent des booléens (Airtable refuse un entier)', () => {
  const cfg = WRITEBACK_MODULES.instagram
  assert.equal(airtableFieldValue(cfg, 'dm_sent', 1), true)
  assert.equal(airtableFieldValue(cfg, 'dm_sent', 0), false)
})

test('orders : les deux champs FORMULE d’Airtable ne sont jamais poussés', () => {
  // Un PATCH sur un champ calculé renvoie 422 : la garde tient même si
  // l'utilisateur règle le sens sur push/both dans /champs/orders.
  assert.ok(WRITEBACK_MODULES.orders.neverPush.has('status'))
  assert.ok(WRITEBACK_MODULES.orders.neverPush.has('order_number'))
})

// ── Champ lien poussable : « Commande » des envois ───────────────────────────
//
// Règle générale : un champ lien n'est JAMAIS réécrit vers Airtable — la colonne
// ERP porte un id Boréal, le champ Airtable attend un tableau de record ids, et
// un PATCH de l'id brut renverrait 422. L'exception se déclare dans le module :
// `linkColumns` dit vers quelle table ERP résoudre l'id, ce qui rend le lien
// poussable ET son sens configurable. Seul « Commande lié » des envois l'est.

function mapShipmentField(column, atName, options) {
  db.prepare(`INSERT OR REPLACE INTO airtable_field_mappings
    (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, import_disabled)
    VALUES (?, 'envois', 'shipments', ?, ?, ?, ?, 0)`)
    .run(`m-${column}`, `fld${column}`, atName, column, JSON.stringify(options))
}

test('envois : commande et adresse sont les champs lien déclarés poussables', () => {
  assert.equal(pushableLinkColumn('envois', 'order_id'), 'orders')
  assert.equal(pushableLinkColumn('envois', 'address_id'), 'adresses')
  // Non déclarés : « items expédiés » côté envois, le produit d'un achat.
  assert.equal(pushableLinkColumn('envois', 'items_expedies'), null)
  assert.equal(pushableLinkColumn('achats', 'product_id'), null)
})

test('envois : les liens déclarés en « both » entrent dans le payload, les autres non', () => {
  mapShipmentField('order_id', 'Commande lié', { link_target_table: 'orders' })
  mapShipmentField('address_id', 'Adresse de livraison', { link_target_table: 'adresses' })
  mapShipmentField('items_expedies', 'items expédiés', { linked_table_id: 'tblXXX' })
  setFieldDirection('envois', 'dyn:order_id', 'both')
  setFieldDirection('envois', 'dyn:address_id', 'both')
  setFieldDirection('envois', 'dyn:items_expedies', 'both')

  const map = buildColumnMap('envois', {})
  assert.equal(map.order_id, 'Commande lié')
  assert.equal(map.address_id, 'Adresse de livraison')
  // Lien non déclaré : le sens a beau être réglé sur « both », il reste hors payload.
  assert.equal(map.items_expedies, undefined)
})

test('envois : un lien déclaré mais réglé en « pull » ne part pas vers Airtable', () => {
  mapShipmentField('order_id', 'Commande lié', { link_target_table: 'orders' })
  mapShipmentField('address_id', 'Adresse de livraison', { link_target_table: 'adresses' })
  setFieldDirection('envois', 'dyn:order_id', 'pull')
  setFieldDirection('envois', 'dyn:address_id', 'pull')
  const map = buildColumnMap('envois', {})
  assert.equal(map.order_id, undefined)
  assert.equal(map.address_id, undefined)
})

// ── Champ CALCULÉ de Boréal : mappable, mais en push seulement ───────────────
//
// Une formule (comme un lookup, un rollup, un « créé le ») n'a pas de colonne
// physique : sa valeur naît dans la vue <table>_v. Rien ne peut donc l'alimenter
// depuis Airtable — mais elle s'y pousse très bien, et c'est le seul sens
// possible : ni réglable, ni contournable par l'API.

function declareTicketFormula(column, kind = 'formula') {
  db.prepare(`INSERT OR REPLACE INTO custom_fields
    (id, erp_table, name, column_name, type, kind) VALUES (?, 'tickets', ?, ?, 'text', ?)`)
    .run(`cf-${column}`, column, column, kind)
}

test('billets : un champ formule est poussé, jamais importé', () => {
  declareTicketFormula('cf_boreal_recordid')
  assert.deepEqual([...pushOnlyColumns('tickets')], ['cf_boreal_recordid'])
  // Aucun sens enregistré, et pourtant 'push' — le défaut 'pull' des champs
  // dynamiques n'a pas de sens ici : il ne pousserait jamais rien.
  assert.equal(dynamicFieldDirection('billets', 'cf_boreal_recordid'), 'push')
})

test('billets : la colonne calculée mappée entre dans le payload de write-back', () => {
  declareTicketFormula('cf_boreal_recordid')
  db.prepare(`INSERT OR REPLACE INTO airtable_field_mappings
    (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, import_disabled)
    VALUES ('m-calc', 'billets', 'tickets', 'fldCalc', 'Call ID', 'cf_boreal_recordid', '{}', 0)`).run()
  assert.equal(buildColumnMap('billets', {}).cf_boreal_recordid, 'Call ID')
})

test('billets : impossible de régler un champ calculé en import', () => {
  declareTicketFormula('cf_boreal_recordid')
  assert.throws(() => setFieldDirection('billets', 'dyn:cf_boreal_recordid', 'pull'), /calculé/)
  assert.throws(() => setFieldDirection('billets', 'dyn:cf_boreal_recordid', 'both'), /calculé/)
  // 'push' est accepté : c'est déjà le sens effectif, l'enregistrer ne change rien.
  assert.equal(setFieldDirection('billets', 'dyn:cf_boreal_recordid', 'push'), 'push')
})

test('une colonne PHYSIQUE portée par un champ calculé garde son sens réglable', () => {
  // Cas des colonnes historiques converties en lookup : la colonne SQLite existe
  // encore et l'import peut l'alimenter — forcer 'push' couperait cet import.
  declareTicketFormula('titre', 'lookup')
  assert.equal(pushOnlyColumns('tickets').has('titre'), false)
  db.prepare(`DELETE FROM custom_fields WHERE id='cf-titre'`).run()
})
