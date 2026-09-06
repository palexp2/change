import db from '../db/database.js'
import { getAccessToken, airtablePatch, airtablePost } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { logSync } from './syncLog.js'
import { ENVOIS_FIELD_MAP_PLAN, ORDERS_FIELD_MAP_PLAN, fieldMapFromUi } from './airtableUiFieldMap.js'
import { nativeMappedColumn } from './airtableNativeMappedColumns.js'
import { readRelation } from './customFieldsView.js'

// Résout l'airtable_id d'un record ERP lié (commande, adresse…) pour un linked record.
function linkedAirtableId(table, erpId) {
  if (!erpId) return null
  const r = db.prepare(`SELECT airtable_id FROM ${table} WHERE id=?`).get(erpId)
  return r?.airtable_id || null
}

// Airtable ids des order_items assignés à un envoi (pour « items expédiés »).
function shipmentItemAirtableIds(shipmentId) {
  return db.prepare('SELECT airtable_id FROM order_items WHERE shipment_id=? AND airtable_id IS NOT NULL')
    .all(shipmentId).map(r => r.airtable_id)
}

// ── Write-back ERP → Airtable ────────────────────────────────────────────────
//
// Module pilote : « achats » (table ERP `purchases`). Quand un achat synchronisé
// depuis Airtable est édité dans l'ERP, on répercute la modification vers
// Airtable via PATCH. Une garde anti-boucle (airtable_writeback_guard) mémorise
// les valeurs poussées pour que le webhook de retour soit reconnu comme un echo
// et ignoré par le sync entrant (cf. consumeWritebackEcho dans syncAchats).
//
// Pour généraliser à d'autres modules : ajouter une entrée à WRITEBACK_MODULES
// (module Airtable ↔ table ERP) et déclencher writeBackRecord() sur l'édition.

export const WRITEBACK_MODULES = {
  achats: {
    erpTable: 'purchases',
    // Clés du field_map qui pointent vers des linked records / champs non scalaires :
    // on ne sait pas les ré-écrire de façon fiable, on les exclut du write-back.
    // `product` → "Nom de la pièce" est un linked record dans Airtable.
    skipKeys: new Set(['product']),
    // Correspondance clé field_map → colonne ERP quand elles diffèrent.
    keyToColumn: { product: 'product_id' },
  },
  envois: {
    erpTable: 'shipments',
    // Les envois n'ont plus de field_map en base : leur mapping se règle dans
    // /champs/shipments et se relit via ce plan (clé logique → colonne ERP).
    // Conséquence pour le write-back : les champs scalaires passent par le
    // chemin DYNAMIQUE de buildColumnMap (sens réglable par champ, clé
    // `dyn:<colonne>`), le mapping cœur ne servant plus qu'aux linked records
    // de la création. `neverPush` garde les colonnes non écrivables côté
    // Airtable même si l'utilisateur y règle un sens push/both.
    uiFieldMapPlan: ENVOIS_FIELD_MAP_PLAN,
    neverPush: new Set(['pays']),
    // Seuls les champs scalaires écrivables côté Airtable sont poussés
    // (tracking_number → "Numéro de tracking", carrier → "Service de livraison",
    //  status → "Statut" singleSelect, shipped_at → "Date" dateTime, notes → "Notes").
    // Exclusions :
    //  • items   → "items expédiés"        : linked record (jamais dans field_map persisté, prudence)
    //  • pays    → "Pays de l'adresse de livraison" : champ lookup (multipleLookupValues)
    //              calculé depuis l'adresse liée → non écrivable, un PATCH dessus renverrait 422.
    //              Il se recalcule tout seul côté Airtable quand l'adresse liée change.
    skipKeys: new Set(['items', 'pays']),
    // Les deux linked records des envois réécrits sur update : la colonne ERP
    // porte un id Boréal, `linkColumns` dit vers quelle table le résoudre pour
    // envoyer [recXXX] à Airtable. Le sens reste réglable dans /champs/shipments
    // (clés `dyn:order_id` / `dyn:address_id`) — déclarer la colonne rend le
    // write-back POSSIBLE, il ne l'active pas.
    //
    // Les deux se délient : un lien retiré dans l'ERP pousse [] et délie donc
    // le record côté Airtable (migration 022 pour la commande). C'est voulu —
    // sans ça, retirer une adresse ne se répercuterait jamais et le lookup
    // « Pays » resterait figé sur l'ancienne.
    linkColumns: { order_id: 'orders', address_id: 'adresses' },
    // Linked records à inclure UNIQUEMENT à la création (create ERP→Airtable).
    // Clé = clé du field_map (donne le nom de champ Airtable), resolve → record ids
    // Airtable à lier. `items` n'est pas poussé sur un simple update (cf. skipKeys) ;
    // `order` et `address` le sont désormais via `linkColumns`. `pays` reste exclu :
    // lookup dérivé de l'adresse, il se remplit tout seul côté Airtable.
    linkedRecords: {
      order:   (row) => { const id = linkedAirtableId('orders', row.order_id); return id ? [id] : null },
      address: (row) => { const id = linkedAirtableId('adresses', row.address_id); return id ? [id] : null },
      items:   (row) => { const ids = shipmentItemAirtableIds(row.id); return ids.length ? ids : null },
    },
  },
  // Webhook write surface (tickets / projects / serial_numbers). Ces modules sont
  // pull-only depuis Airtable ; sans write-back, une écriture ERP sur une colonne
  // mappée serait écrasée au prochain sync. Le write-back est best-effort : il ne
  // pousse que les colonnes scalaires mappées (les colonnes ERP-natives — assigned_to,
  // vendeur_ref, notes, custom fields… — restent en DB, jamais clobberées car le sync
  // entrant fait un upsert sélectif). Les linked records (company/contact) sont exclus.
  billets: {
    erpTable: 'tickets',
    skipKeys: new Set(['company', 'contact']),
    keyToColumn: { company: 'company_id', contact: 'contact_id' },
  },
  projets: {
    erpTable: 'projects',
    skipKeys: new Set(['company', 'contact']),
    keyToColumn: { company: 'company_id', contact: 'contact_id' },
    // field_map des projets vit dans airtable_projets_config (singleton), pas dans
    // airtable_module_config — d'où la source de config dédiée.
    configSource: { table: 'airtable_projets_config', baseCol: 'base_id', tableIdCol: 'projects_table_id', fieldMapCol: 'field_map_projects' },
  },
  serials: {
    erpTable: 'serial_numbers',
    skipKeys: new Set(['product', 'company', 'order_item']),
    keyToColumn: { product: 'product_id', company: 'company_id', order_item: 'order_item_id' },
  },
  paies: {
    erpTable: 'paies',
    skipKeys: new Set([]),
  },
  paie_items: {
    erpTable: 'paie_items',
    // Clés réelles du field_map (cf. syncPaieItems) : paie_link / employee_link.
    skipKeys: new Set(['paie_link', 'employee_link']),
    keyToColumn: { paie_link: 'paie_id', employee_link: 'employee_id' },
    linkedRecords: {
      paie_link:     (row) => { const id = linkedAirtableId('paies', row.paie_id); return id ? [id] : null },
      employee_link: (row) => { const id = linkedAirtableId('employees', row.employee_id); return id ? [id] : null },
    },
  },
  // Prospects Instagram : l'ERP est la source de vérité, Airtable n'est qu'une
  // surface d'édition pour Philippe. `skipKeys` est VOLONTAIREMENT vide —
  // contrairement à l'intuition, y mettre une clé la force en 'pull' (Airtable →
  // ERP), soit l'inverse du besoin. La protection des champs système passe par
  // le seed de airtable_field_directions (schema.js) : 'push' partout sauf
  // follow_up_status et notes en 'both'. Sans ce seed, fieldMapDirection
  // renverrait 'both' par défaut et une édition Airtable pourrait écraser
  // dm_sent — donc faire recontacter quelqu'un.
  instagram: {
    erpTable: 'instagram_prospects',
    skipKeys: new Set(),
    // SQLite stocke ces colonnes en 0/1 ; les champs Airtable correspondants sont
    // des Cases à cocher, qui refusent un entier même avec typecast (Airtable ne
    // convertit pas nombre → booléen). Coercition explicite ci-dessous.
    booleanKeys: new Set(['dm_sent', 'replied', 'contacted']),
    // « Name » est le champ-titre obligatoire d'Airtable (impossible à
    // supprimer) ; il n'est mappé par aucune clé ERP et resterait donc
    // toujours vide (fiches sans titre). On y reflète le nom d'usager.
    primaryFieldMirror: { from: "Nom d'usager", to: 'Name' },
  },
  // Commandes : plus de field_map en base non plus (cf. retireOrdersCoreFieldMap).
  // Le mapping se règle dans /champs/orders, donc TOUS les scalaires passent par
  // le chemin dynamique de buildColumnMap, sens réglable champ par champ
  // (`dyn:<colonne>`). `skipKeys` est volontairement VIDE : avec un
  // `uiFieldMapPlan`, la boucle cœur de buildColumnMap est sautée, et y laisser
  // une clé ne servirait qu'à verrouiller son sens en 'pull' dans une modale de
  // mapping cœur qui n'existe plus pour ce module.
  //
  // Ce qui est réellement poussé vers Airtable : Notes (multilineText), Priorité
  // (singleSelect) et Abonnement (singleSelect Oui/Non, via `valueCodecs`).
  // `neverPush` couvre les deux champs FORMULE d'Airtable — « Statut » et
  // « # de commande » — qu'un PATCH ferait échouer en 422 : la garde tient même
  // si l'utilisateur y règle un sens push/both dans l'interface. Les liens
  // (entreprise, projet, adresse) sortent d'eux-mêmes du payload : leur mapping
  // porte un link_target_table et la colonne ERP un id local.
  orders: {
    erpTable: 'orders',
    uiFieldMapPlan: ORDERS_FIELD_MAP_PLAN,
    skipKeys: new Set(),
    neverPush: new Set(['status', 'order_number']),
    keyToColumn: { company: 'company_id', project: 'project_id', address: 'address_id' },
    // La colonne ERP est un 0/1 ; le champ Airtable « Abonnement » est un
    // singleSelect Oui/Non (pas une case à cocher) — sans ce codec, Airtable
    // reçoit un entier et rejette l'écriture.
    valueCodecs: { is_subscription: v => (v ? 'Oui' : 'Non') },
    configSource: { table: 'airtable_orders_config', baseCol: 'base_id', tableIdCol: 'orders_table_id', fieldMapCol: 'field_map_orders' },
  },
  // Lignes de commande. Le champ intéressant côté ERP est le PRODUIT, qui est un
  // linked record Airtable (« Produit » → table des pièces) : d'où `linkColumns`,
  // qui convertit l'id ERP en record id Airtable au moment du PATCH.
  //
  // `defaultDirection: 'pull'` — contrairement aux modules dont le write-back
  // existait avant le sélecteur de sens, déclarer ce module ne doit RIEN pousser
  // tant que l'utilisateur n'a pas choisi : il rend le sens choisissable, point.
  order_items: {
    erpTable: 'order_items',
    // 'order'     : lien vers la commande — c'est lui qui rattache la ligne à
    //               l'import, le ré-écrire depuis l'ERP n'a pas de sens.
    // 'unit_cost' : « Coût unitaire actuel » est un lookup Airtable (dérivé du
    //               produit lié) — non écrivable, un PATCH dessus renvoie 422.
    skipKeys: new Set(['order', 'unit_cost']),
    keyToColumn: { product: 'product_id' },
    // Colonne ERP portant un id local → champ Airtable linked record. Valeur
    // poussée : [record id du produit], ou [] si l'ERP a retiré le produit.
    linkColumns: { product_id: 'products' },
    defaultDirection: 'pull',
    configSource: { table: 'airtable_orders_config', baseCol: 'base_id', tableIdCol: 'items_table_id', fieldMapCol: 'field_map_items' },
  },
}

// Table ERP → module write-back (réciproque de WRITEBACK_MODULES.erpTable).
// Sert aux chemins qui ne connaissent que la table ERP (sync dynamique,
// mapping-data) pour retrouver la clé sous laquelle les sens sont stockés.
const ERP_TABLE_TO_MODULE = Object.fromEntries(
  Object.entries(WRITEBACK_MODULES).map(([m, cfg]) => [cfg.erpTable, m])
)
export function writebackModuleForTable(erpTable) {
  return ERP_TABLE_TO_MODULE[erpTable] || null
}

// ── Champs dynamiques (airtable_field_mappings) ──────────────────────────────
//
// En plus des clés du field_map « cœur », l'utilisateur peut régler le sens de
// sync des champs mappés dynamiquement (page /champs/:table). Leur sens est
// stocké dans airtable_field_directions sous la clé `dyn:<colonne ERP>` — le
// préfixe évite toute collision avec une clé cœur homonyme. Défaut : 'pull'
// (comportement historique — un champ dynamique n'est jamais poussé tant que
// l'utilisateur n'a pas choisi l'inverse).
const DYN_PREFIX = 'dyn:'
export function dynamicDirectionKey(column) { return `${DYN_PREFIX}${column}` }
export function isDynamicDirectionKey(key) { return typeof key === 'string' && key.startsWith(DYN_PREFIX) }

// ── Champs CALCULÉS de Boréal : mappables en sens push seulement ─────────────
//
// Une formule (et de même un lookup, un rollup, un « créé le / modifié par »)
// n'a pas de colonne physique : sa valeur est calculée à la lecture par la VUE
// <table>_v (services/customFieldsView.js). Rien ne peut donc l'ALIMENTER
// depuis Airtable — mais elle peut parfaitement être POUSSÉE vers un champ
// Airtable écrivable. C'est le seul sens possible, et il n'est pas négociable :
// pas de sélecteur de sens sur ces champs.
//
// `button` en est exclu : une action ne porte aucune valeur, il n'y a rien à
// pousser (cf. noMappingReason côté client).
export const PUSH_ONLY_CF_KINDS = new Set([
  'formula', 'lookup', 'rollup',
  'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
])

// Colonnes d'une table portées par un champ calculé actif. Une colonne
// PHYSIQUE en est exclue même si un champ calculé la porte : elle est peut-être
// alimentée par l'import, et le sens de sync doit y rester le choix de
// l'utilisateur. Seules les colonnes virtuelles (celles que seule la vue
// <table>_v produit) sont poussées d'office.
export function pushOnlyColumns(erpTable) {
  try {
    const placeholders = [...PUSH_ONLY_CF_KINDS].map(() => '?').join(',')
    const computed = db.prepare(
      `SELECT column_name FROM custom_fields
       WHERE erp_table=? AND deleted_at IS NULL AND kind IN (${placeholders})`
    ).all(erpTable, ...PUSH_ONLY_CF_KINDS).map(r => r.column_name)
    if (!computed.length) return new Set()
    const physical = new Set(db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name))
    return new Set(computed.filter(c => !physical.has(c)))
  } catch { return new Set() }  // table custom_fields absente (tests)
}

export function dynamicFieldDirection(module, column) {
  if (!module || !WRITEBACK_MODULES[module]) return 'pull'
  // Colonne native à résolveur (ex. projects.vendeur_ref) : la colonne porte une
  // référence Boréal (`employee:<id>`), illisible pour Airtable — jamais poussée.
  if (nativeMappedColumn(WRITEBACK_MODULES[module].erpTable, column)?.pull_only) return 'pull'
  // Champ calculé : le sens ne peut être que 'push', quoi qu'il y ait en base.
  if (pushOnlyColumns(WRITEBACK_MODULES[module].erpTable).has(column)) return 'push'
  const override = readDirectionOverride(module, dynamicDirectionKey(column))
  return (override === 'pull' || override === 'push' || override === 'both') ? override : 'pull'
}

// Vrai si le module supporte le write-back → le sens des champs dynamiques y
// est configurable (sauf champs lien non déclarés poussables, cf. ci-dessous).
export function isDynamicDirectionConfigurable(module) {
  return !!WRITEBACK_MODULES[module]
}

// Table ERP cible d'une colonne lien que le module sait POUSSER vers Airtable
// (null si la colonne n'est pas un lien poussable). C'est la seule dérogation à
// la règle « un champ lien n'est jamais réécrit » : le module déclare la table
// dans laquelle résoudre l'id Boréal en record id Airtable, ce qui rend le PATCH
// possible — et donc le sens du champ configurable dans /champs/:table.
export function pushableLinkColumn(module, column) {
  return WRITEBACK_MODULES[module]?.linkColumns?.[column] || null
}

// Sens de synchronisation d'une clé du field_map d'un module, pour affichage
// (modale de mapping) ET pour piloter le write-back : 'both' = importé depuis
// Airtable ET réécrit vers Airtable, 'pull' = Airtable → ERP seulement, 'push' =
// ERP → Airtable seulement. Les clés non write-back-éligibles (module sans
// write-back, ou linked record / champ calculé exclu) sont toujours 'pull' et
// non configurables. Sinon, l'utilisateur peut choisir le sens (table
// airtable_field_directions) ; défaut = 'both', ou `defaultDirection` du module
// (les modules ajoutés APRÈS le sélecteur de sens partent en 'pull' : déclarer
// le module rend le choix possible, il n'active pas un write-back en douce).
export function fieldMapDirection(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return 'pull'
  if (cfg.skipKeys.has(key)) return 'pull'
  const override = readDirectionOverride(module, key)
  return (override === 'pull' || override === 'push' || override === 'both')
    ? override
    : (cfg.defaultDirection || 'both')
}

// Vrai si le sens de sync de cette clé est configurable par l'utilisateur
// (champ scalaire write-back-éligible d'un module supportant le write-back).
export function isDirectionConfigurable(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  return !!(cfg && !cfg.skipKeys.has(key))
}

// Raison pour laquelle le sens d'une clé cœur est verrouillé en 'pull' (null si
// configurable) — exposée dans les réponses core-map/mapping-data pour que le
// client affiche une infobulle honnête au lieu du texte générique :
//   'module_no_writeback' → le module ne supporte pas (encore) le write-back
//   'core_skip'           → clé du field_map exclue (linked record / valeur
//                            dérivée) : gérée par la synchronisation cœur.
export function coreDirectionLockReason(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return 'module_no_writeback'
  if (cfg.skipKeys.has(key)) return 'core_skip'
  return null
}

// Lit le sens choisi par l'utilisateur pour une clé (null si aucun override).
function readDirectionOverride(module, key) {
  try {
    const row = db.prepare('SELECT direction FROM airtable_field_directions WHERE module=? AND field_key=?').get(module, key)
    return row?.direction || null
  } catch { return null }
}

// Enregistre le sens de sync choisi pour une clé configurable. Lève si le sens
// est invalide ou si la clé n'est pas configurable (linked record / module sans
// write-back — on ne peut pas y activer un write-back fiable).
export function setFieldDirection(module, key, direction) {
  if (!['pull', 'push', 'both'].includes(direction)) throw new Error('Sens invalide (pull, push ou both)')
  const configurable = isDynamicDirectionKey(key)
    ? isDynamicDirectionConfigurable(module)
    : isDirectionConfigurable(module, key)
  if (!configurable) throw new Error('Ce champ ne supporte pas le choix du sens de synchronisation')
  // Champ calculé : rien ne peut l'alimenter depuis Airtable, seul 'push' a un sens.
  if (isDynamicDirectionKey(key) && direction !== 'push'
      && pushOnlyColumns(WRITEBACK_MODULES[module].erpTable).has(key.slice(DYN_PREFIX.length))) {
    throw new Error('Champ calculé : seul le sens Boréal → Airtable est possible')
  }
  db.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES (?,?,?)
    ON CONFLICT(module, field_key) DO UPDATE SET direction=excluded.direction
  `).run(module, key, direction)
  return direction
}

// Lit base_id / table_id / field_map du module. La plupart des modules vivent dans
// airtable_module_config (clé `module`), mais certains (projets) ont leur propre
// table singleton — déclaré via cfg.configSource. Retourne null si absent.
function readAirtableConfig(module) {
  const src = WRITEBACK_MODULES[module]?.configSource
  if (src) {
    // Colonnes interpolées depuis configSource (littéraux du code, jamais user input) → safe.
    return db.prepare(
      `SELECT ${src.baseCol} AS base_id, ${src.tableIdCol} AS table_id, ${src.fieldMapCol} AS field_map FROM ${src.table} LIMIT 1`
    ).get()
  }
  return db.prepare('SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module=?').get(module)
}

// field_map du module : lu en base pour les modules à mapping « cœur »,
// reconstruit depuis /champs/:table (airtable_field_mappings) pour ceux qui
// déclarent un `uiFieldMapPlan` — cf. services/airtableUiFieldMap.js.
function readFieldMap(module, config) {
  const cfg = WRITEBACK_MODULES[module]
  if (cfg?.uiFieldMapPlan) return fieldMapFromUi(cfg.erpTable, cfg.uiFieldMapPlan)
  try { return JSON.parse(config?.field_map || 'null') } catch { return null }
}

// Config Airtable exploitable pour un write-back : base + table, plus un
// field_map pour les modules qui en dépendent encore.
function writebackConfigMissing(module, config) {
  if (!config?.base_id || !config?.table_id) return true
  return !WRITEBACK_MODULES[module]?.uiFieldMapPlan && !config.field_map
}

// Tables exposées au moteur de webhooks → clé module write-back correspondante.
// Une écriture du webhook sur une de ces tables déclenche un write-back best-effort.
export const TABLE_TO_WRITEBACK_MODULE = {
  tickets: 'billets',
  projects: 'projets',
  serial_numbers: 'serials',
}

// TTL de la garde : au-delà, une entrée non consommée est considérée périmée
// (le webhook a été manqué ou un vrai changement Airtable est survenu depuis).
const GUARD_TTL_MS = 2 * 60 * 1000

// Normalise une valeur (envoyée ou reçue d'Airtable) pour comparaison d'echo.
function normVal(v) {
  if (v == null || v === '') return ''
  if (Array.isArray(v)) return v.map(normVal).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).trim()
}

// Mémorise les champs poussés vers Airtable AVANT le PATCH, pour que le webhook
// de retour (echo) soit reconnaissable même s'il arrive très vite.
export function recordWriteback(airtableId, fields) {
  db.prepare(`
    INSERT INTO airtable_writeback_guard (airtable_id, fields_json, written_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(airtable_id) DO UPDATE SET
      fields_json = excluded.fields_json,
      written_at = excluded.written_at
  `).run(airtableId, JSON.stringify(fields))
}

// Appelé par le sync entrant (webhook) pour chaque record Airtable. Renvoie true
// si ce record correspond à un write-back ERP récent dont les valeurs n'ont pas
// changé depuis → c'est notre propre echo, le sync doit l'ignorer.
// Consomme (supprime) l'entrée de garde dans tous les cas où elle est résolue.
export function consumeWritebackEcho(airtableId, airtableFields) {
  const row = db.prepare('SELECT fields_json, written_at FROM airtable_writeback_guard WHERE airtable_id=?').get(airtableId)
  if (!row) return false

  const age = Date.now() - new Date(row.written_at).getTime()
  if (!(age >= 0) || age > GUARD_TTL_MS) {
    // Entrée périmée : on la nettoie et on laisse le sync traiter normalement.
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  let pushed
  try { pushed = JSON.parse(row.fields_json) } catch { pushed = null }
  if (!pushed || typeof pushed !== 'object') {
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  // Echo confirmé seulement si TOUS les champs poussés correspondent encore aux
  // valeurs Airtable actuelles. Sinon un vrai changement a eu lieu après notre
  // write → on laisse le sync l'appliquer.
  const fields = airtableFields || {}
  const isEcho = Object.entries(pushed).every(([k, v]) => normVal(fields[k]) === normVal(v))

  // Garde à usage unique : on la supprime qu'il s'agisse d'un echo ou non.
  db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
  return isEcho
}

// Valeur à envoyer à Airtable pour une colonne ERP, selon le module.
//   • `valueCodecs[col]`  : traduction explicite (ex. is_subscription 0/1 → « Non »/« Oui »
//                           sur un singleSelect Airtable). Un null reste un null :
//                           on efface le champ, on ne traduit pas « vide ».
//   • `booleanKeys`       : colonne 0/1 → vrai booléen (case à cocher Airtable,
//                           qui refuse un entier même avec typecast).
//   • sinon la valeur brute, `undefined` ramené à null (= effacer le champ).
// Exportée pour être testable sans appel réseau : c'est la seule règle de
// conversion du write-back, partagée par le PATCH de mise à jour et le POST de
// création.
export function airtableFieldValue(cfg, col, value) {
  const codec = cfg?.valueCodecs?.[col]
  if (codec) return value == null ? null : codec(value)
  if (cfg?.booleanKeys?.has(col)) return value == null ? null : !!value
  return value ?? null
}

// Construit la correspondance colonne ERP → nom de champ Airtable à partir du
// field_map du module, en excluant les clés non scalaires, puis y ajoute les
// champs dynamiques (airtable_field_mappings) dont l'utilisateur a réglé le
// sens sur push/both.
export function buildColumnMap(module, fieldMap) {
  const cfg = WRITEBACK_MODULES[module]
  const out = {}
  // Module sans field_map en base (mapping réglé dans /champs/:table) : ses
  // champs scalaires sont des mappings dynamiques, traités plus bas — les
  // reprendre ici les ferait pousser sous une clé de sens (`<clé>`) que l'UI
  // n'expose plus, au lieu de `dyn:<colonne>`.
  if (!cfg.uiFieldMapPlan) {
    for (const [key, atField] of Object.entries(fieldMap || {})) {
      if (!atField) continue                       // pas de champ Airtable mappé
      if (cfg.skipKeys.has(key)) continue          // linked record / non scalaire
      if (fieldMapDirection(module, key) === 'pull') continue  // sens Airtable → ERP : pas de write-back
      const col = cfg.keyToColumn?.[key] || key
      out[col] = atField
    }
  }
  // Champs dynamiques : défaut 'pull' (jamais poussés) — seuls ceux passés en
  // push/both par l'utilisateur rejoignent le write-back. Les champs lien sont
  // exclus (la colonne ERP porte un id local, pas une valeur Airtable).
  try {
    const defs = db.prepare(`
      SELECT airtable_field_name, column_name, options FROM airtable_field_mappings
      WHERE erp_table=? AND import_disabled IS NOT 1 AND column_name != '__pending__'
    `).all(cfg.erpTable)
    // Champs Airtable déjà écrits par une autre colonne (cœur ou dynamique) :
    // depuis qu'un même champ Airtable peut alimenter plusieurs colonnes Boréal,
    // deux d'entre elles pourraient prétendre le remplir. À l'import c'est sans
    // risque (une source, deux copies) ; au write-back ce serait une valeur
    // tirée au sort. La première colonne rencontrée garde la main.
    const pushed = new Set(Object.values(out))
    for (const d of defs) {
      if (!d.column_name || out[d.column_name]) continue  // colonne déjà couverte par le mapping cœur
      if (pushed.has(d.airtable_field_name)) continue     // champ Airtable déjà poussé par une autre colonne
      if (cfg.neverPush?.has(d.column_name)) continue     // champ calculé/lookup Airtable : un PATCH renverrait 422
      if (dynamicFieldDirection(module, d.column_name) === 'pull') continue
      let opts = {}
      try { opts = JSON.parse(d.options || '{}') } catch {}
      // Champ lien : pas poussé par défaut. Un champ « linked record » d'Airtable
      // attend un TABLEAU de record IDs ; la colonne ERP porte soit des ids
      // Boréal (`link_target_table` posée), soit les record IDs en texte
      // (`linked_table_id` seul) — pousser la valeur telle quelle renverrait 422.
      // Exception : les colonnes déclarées dans `linkColumns`, dont le module dit
      // vers quelle table ERP les résoudre — writeBackRecord les traduit alors en
      // [recXXX] (cf. « Commande lié » des envois). Pour toutes les autres, les
      // associations faites dans l'ERP restent locales.
      if ((opts.link_target_table || opts.linked_table_id) && !cfg.linkColumns?.[d.column_name]) continue
      out[d.column_name] = d.airtable_field_name
      pushed.add(d.airtable_field_name)
    }
  } catch { /* table de mappings absente (tests) : champs cœur seulement */ }
  return out
}

// Complète `row` (lue sur la table physique) avec la valeur des colonnes
// CALCULÉES mappées, qui n'existent que dans la vue <table>_v. Mute `row` et
// renvoie l'ensemble des colonnes ainsi remplies (vide si le module n'en mappe
// aucune — la vue n'est alors même pas interrogée).
function mergeComputedValues(erpTable, recordId, row, columnMap) {
  const cols = [...pushOnlyColumns(erpTable)].filter(c => columnMap[c] && !(c in row))
  if (!cols.length) return new Set()
  const relation = readRelation(erpTable)
  if (relation === erpTable) return new Set()   // vue absente : rien à calculer
  const values = db.prepare(
    `SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM ${relation} WHERE id=?`
  ).get(recordId)
  if (!values) return new Set()
  Object.assign(row, values)
  return new Set(cols)
}

// Pousse une modification d'un record ERP vers Airtable.
// @param module        clé module Airtable ('achats')
// @param recordId      id ERP du record
// @param changedColumns  optionnel : colonnes réellement modifiées (filtre le payload)
export async function writeBackRecord(module, recordId, changedColumns = null) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try : les lectures DB (config, record), buildColumnMap
  // et getFrozenColumns peuvent lever AVANT l'appel réseau. Sans ce filet, ces
  // throws s'échappaient en fire-and-forget et n'étaient capturés que par un
  // console.error côté route — aucune trace dans sync_log, write-back rompu en
  // silence. Désormais tout échec produit exactement une entrée sync_log error.
  const t0 = Date.now()
  let airtableId = null
  try {
    const config = readAirtableConfig(module)
    if (writebackConfigMissing(module, config)) return { skipped: 'config Airtable absente' }

    const row = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!row) return { skipped: 'record introuvable' }
    if (!row.airtable_id) return { skipped: 'record non lié à Airtable' } // pilote : update only
    airtableId = row.airtable_id

    const fieldMap = readFieldMap(module, config)
    if (!fieldMap) return { skipped: 'field_map illisible' }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)
    const changedSet = changedColumns ? new Set(changedColumns) : null
    // Champs calculés mappés : leur valeur n'est pas dans la table physique, on
    // la lit dans la vue <table>_v. Ils échappent aussi au filtre `changedColumns` :
    // une formule dépend d'AUTRES colonnes, donc « la formule n'a pas changé »
    // n'existe pas — on la repousse à chaque write-back du record.
    const computed = mergeComputedValues(cfg.erpTable, recordId, row, columnMap)

    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (changedSet && !changedSet.has(col) && !computed.has(col)) continue   // ne pousser que ce qui a changé
      if (frozen.has(col)) continue                       // colonne gelée : jamais écrite
      if (!(col in row)) continue                         // colonne supprimée de la table : ne pas pousser null
      // Colonne lien : la valeur ERP est un id local, Airtable attend un tableau
      // de record ids. Un référent sans jumeau Airtable est SAUTÉ plutôt que
      // poussé vide — effacer le lien serait pire que ne rien faire.
      const linkTable = cfg.linkColumns?.[col]
      if (linkTable) {
        if (row[col]) {
          const linkedId = linkedAirtableId(linkTable, row[col])
          if (!linkedId) continue
          fields[atField] = [linkedId]
        } else {
          fields[atField] = []                            // délié côté ERP → délier côté Airtable
        }
        continue
      }
      fields[atField] = airtableFieldValue(cfg, col, row[col])  // null = effacer le champ Airtable
    }
    if (cfg.primaryFieldMirror && fields[cfg.primaryFieldMirror.from] != null) {
      fields[cfg.primaryFieldMirror.to] = fields[cfg.primaryFieldMirror.from]
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    // Mémoriser AVANT le PATCH : le webhook peut revenir avant la fin du fetch.
    recordWriteback(airtableId, fields)
    await airtablePatch(`/${config.base_id}/${config.table_id}/${airtableId}`, token, {
      fields,
      typecast: true,
    })
    logSync(module, 'erp-writeback', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`↩️  Write-back ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    // Échec : retirer la garde (si posée) sinon elle masquerait un vrai sync entrant ultérieur.
    if (airtableId) db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    logSync(module, 'erp-writeback', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Write-back ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}

// Crée dans Airtable un record ERP qui n'y existe pas encore (sens ERP → Airtable),
// puis mémorise l'airtable_id retourné sur la ligne ERP. C'est le pendant « création »
// de writeBackRecord (qui ne gère que l'update d'un record déjà lié). Pousse les
// champs scalaires (mêmes exclusions que l'update) + les linked records configurés
// dans WRITEBACK_MODULES[module].linkedRecords (commande, adresse, items). La garde
// anti-boucle est posée pour que le webhook de création de retour soit reconnu comme
// notre propre echo et non ré-importé. Idempotent : si le record a déjà un airtable_id,
// on ne fait rien.
// ── Champs calculés par Airtable, au moment de la création ERP → Airtable ─────
//
// Airtable renvoie le record créé AVEC ses champs calculés (« # d'envoi », qui
// est une formule/autonumber, lookups…). Sans cette passe, ces valeurs
// n'arriveraient dans l'ERP qu'au prochain sync complet : le webhook « record
// created » qui les rapporterait est justement reconnu comme notre propre echo
// par la garde anti-boucle et ignoré. Un envoi créé dans l'ERP restait donc sans
// numéro d'envoi, parfois pendant des jours.
//
// Règle de prudence : on ne remplit QUE des colonnes vides côté ERP, et
// uniquement à partir de valeurs Airtable non vides. Jamais d'écrasement — le
// chemin sert aussi de rattrapage pour de vieux envois (PATCH d'un record sans
// airtable_id), dont les colonnes ERP-natives ne doivent pas être effacées.
async function importCreatedComputedFields(cfg, recordId, atFields) {
  const { convertValue } = await import('./airtableAutoSync.js')
  const frozen = getFrozenColumns(cfg.erpTable)
  const liveCols = new Set(db.prepare(`PRAGMA table_info(${cfg.erpTable})`).all().map(c => c.name))
  const defs = db.prepare(`
    SELECT m.airtable_field_id, m.airtable_field_name, m.column_name, m.options,
           cf.type AS render_type, cf.options AS render_options
    FROM airtable_field_mappings m
    LEFT JOIN custom_fields cf
      ON cf.erp_table = m.erp_table AND cf.column_name = m.column_name AND cf.deleted_at IS NULL
    WHERE m.erp_table=? AND m.import_disabled IS NOT 1 AND m.column_name != '__pending__'
  `).all(cfg.erpTable)

  let filled = 0
  for (const d of defs) {
    // Defs `native_*` : leur airtable_field_name est un libellé ERP, pas un champ Airtable.
    if (String(d.airtable_field_id || '').startsWith('native_')) continue
    if (!d.column_name || !liveCols.has(d.column_name)) continue
    if (frozen.has(d.column_name)) continue
    const raw = atFields[d.airtable_field_name]
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue

    let mappingOptions = {}
    try { mappingOptions = JSON.parse(d.options || '{}') } catch { /* options illisibles */ }
    let renderOptions = {}
    try { renderOptions = JSON.parse(d.render_options || '{}') } catch { /* options illisibles */ }
    const isLink = !!mappingOptions.link_target_table
    const value = convertValue(raw, isLink ? 'link' : (d.render_type || 'text'), {
      format: mappingOptions.format,
      ...renderOptions,
      link_target_table: mappingOptions.link_target_table || null,
      ref_resolver: mappingOptions.ref_resolver || null,
    })
    if (value == null || value === '') continue

    // Colonne interpolée : provient de airtable_field_mappings, pas d'une saisie
    // libre de la requête — et validée contre les colonnes live juste au-dessus.
    const res = db.prepare(
      `UPDATE ${cfg.erpTable} SET ${d.column_name}=? WHERE id=? AND (${d.column_name} IS NULL OR ${d.column_name}='')`
    ).run(value, recordId)
    filled += res.changes
  }
  return filled
}

export async function createInAirtable(module, recordId) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try (cf. writeBackRecord) : les lectures DB et la
  // construction du payload peuvent lever AVANT l'appel réseau. C'est précisément
  // le cas qui cassait le 2-way sync en silence — un envoi créé dans l'ERP restait
  // sans airtable_id quand Airtable était indisponible, et le throw fire-and-forget
  // n'aboutissait qu'à un console.error. Désormais chaque échec laisse une trace
  // sync_log error (avec le recordId) exploitable depuis l'historique des syncs.
  const t0 = Date.now()
  try {
    const config = readAirtableConfig(module)
    if (writebackConfigMissing(module, config)) return { skipped: 'config Airtable absente' }

    const row = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!row) return { skipped: 'record introuvable' }
    if (row.airtable_id) return { skipped: 'record déjà lié à Airtable' }

    const fieldMap = readFieldMap(module, config)
    if (!fieldMap) return { skipped: 'field_map illisible' }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)
    mergeComputedValues(cfg.erpTable, recordId, row, columnMap)

    // Champs scalaires : on n'envoie que les valeurs non vides (un null sur un champ
    // singleSelect/lookup inexistant à la création est inutile et peut bruiter).
    // Les colonnes lien poussables (`linkColumns`) portent un id Boréal : elles
    // se traduisent en [recXXX], jamais en texte brut — sans quoi Airtable
    // recevrait un uuid dans un champ « linked record ».
    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (frozen.has(col)) continue
      const linkTable = cfg.linkColumns?.[col]
      if (linkTable) {
        const linkedId = row[col] ? linkedAirtableId(linkTable, row[col]) : null
        if (linkedId) fields[atField] = [linkedId]
        continue
      }
      const v = airtableFieldValue(cfg, col, row[col])
      if (v != null && v !== '') fields[atField] = v
    }
    if (cfg.primaryFieldMirror && fields[cfg.primaryFieldMirror.from] != null) {
      fields[cfg.primaryFieldMirror.to] = fields[cfg.primaryFieldMirror.from]
    }

    // Linked records (commande, adresse, items) — seulement si le field_map nomme le
    // champ Airtable correspondant et qu'on a des record ids à lier.
    for (const [key, resolve] of Object.entries(cfg.linkedRecords || {})) {
      const atField = fieldMap[key]
      if (!atField) continue
      const ids = resolve(row)
      if (ids && ids.length) fields[atField] = ids
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    const resp = await airtablePost(`/${config.base_id}/${config.table_id}`, token, { fields, typecast: true })
    const airtableId = resp?.id
    if (!airtableId) throw new Error('réponse Airtable sans id')

    // Atomique : poser l'airtable_id ET la garde anti-boucle dans une seule
    // transaction. Si recordWriteback échouait après l'UPDATE, la garde manquerait
    // et le webhook « record created » ré-importerait le record en doublon (boucle
    // de sync). Le tout-ou-rien garantit qu'on n'a jamais un airtable_id lié sans
    // sa garde, ni l'inverse.
    db.transaction(() => {
      db.prepare(`UPDATE ${cfg.erpTable} SET airtable_id=? WHERE id=?`).run(airtableId, recordId)
      // Garde anti-boucle : le webhook « record created » va revenir avec ces valeurs,
      // consumeWritebackEcho le reconnaîtra et le sync entrant ne le ré-importera pas.
      recordWriteback(airtableId, fields)
    })()

    // Récupère les champs calculés par Airtable (« # d'envoi »…) depuis la réponse
    // du POST. Best-effort : un échec ici ne remet pas en cause la création, le
    // prochain sync complet rattrapera les valeurs manquantes.
    try {
      await importCreatedComputedFields(cfg, recordId, resp?.fields || {})
    } catch (e) {
      console.error(`❌ Create ${module} ${recordId} — champs calculés:`, e.message)
    }

    logSync(module, 'erp-create', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`➕ Create ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    logSync(module, 'erp-create', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Create ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}
