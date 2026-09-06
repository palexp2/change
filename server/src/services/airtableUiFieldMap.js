// Mapping Airtable ↔ ERP dérivé de l'interface « Configuration des champs »
// (/champs/:table), pour les modules qui n'ont plus de field_map « cœur ».
//
// Historiquement, chaque module de sync portait DEUX systèmes de mapping :
//   1. le field_map « cœur » (airtable_module_config.field_map) — un blob JSON
//      { clé logique → nom du champ Airtable } édité nulle part (ou via la
//      modale de mapping cœur, cf. CORE_FIELD_SPECS dans routes/connectors.js) ;
//   2. les mappings dynamiques (airtable_field_mappings) — une ligne par
//      colonne ERP, réglés champ par champ dans /champs/:table.
//
// Un champ nommé dans le field_map était EXCLU du picker de /champs/:table
// (liste `hardcoded` de mapping-data) : impossible, par exemple, de brancher
// « N° de suivi » des envois sur un champ Airtable depuis l'interface.
//
// Le module envois est donc passé au système unique : plus de field_map en
// base, le mapping se lit dans airtable_field_mappings et se règle uniquement
// dans /champs/shipments. `fieldMapFromUi()` reconstruit, à la volée, l'objet
// de la même forme que l'ancien field_map — les chemins de sync et de
// write-back continuent de raisonner en clés logiques.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'

// Clé logique du sync envois → colonne ERP de `shipments` qui la porte.
// La clé `items` (« items expédiés » → order_items.shipment_id) n'y figure pas :
// elle n'alimente aucune colonne de shipments, donc aucune ligne de
// /champs/shipments ne peut la porter — elle reste auto-détectée par nom dans
// syncEnvois (autoMapField).
export const ENVOIS_FIELD_MAP_PLAN = {
  order:           'order_id',
  tracking_number: 'tracking_number',
  carrier:         'carrier',
  status:          'status',
  shipped_at:      'shipped_at',
  notes:           'notes',
  pays:            'pays',
  address:         'address_id',
}

// Clé logique du sync commandes → colonne ERP de `orders` qui la porte.
// Toutes les clés de l'ancien `field_map_orders` y figurent, plus `address`
// (jamais mappée du temps du field_map, mais la colonne existe et le plan cœur
// du miroir sait la résoudre).
export const ORDERS_FIELD_MAP_PLAN = {
  order_number:    'order_number',
  company:         'company_id',
  project:         'project_id',
  status:          'status',
  priority:        'priority',
  notes:           'notes',
  is_subscription: 'is_subscription',
  address:         'address_id',
}

// Colonne ERP → nom du champ Airtable, tel que réglé dans /champs/:table.
// Les defs `native_*` (whitelist interne posée par ensureNativeFieldDefs) sont
// écartées : leur `airtable_field_name` est un LIBELLÉ ERP, pas un champ
// Airtable. Les modules concernés ici n'en déclarent pas.
export function uiFieldNameByColumn(erpTable) {
  const rows = db.prepare(`
    SELECT column_name, airtable_field_name, airtable_field_id
    FROM airtable_field_mappings
    WHERE erp_table=? AND import_disabled IS NOT 1 AND column_name != '__pending__'
  `).all(erpTable)
  const byColumn = new Map()
  for (const r of rows) {
    if (!r.airtable_field_name) continue
    if (String(r.airtable_field_id || '').startsWith('native_')) continue
    byColumn.set(r.column_name, r.airtable_field_name)
  }
  return byColumn
}

// Reconstruit un field_map { clé logique → nom du champ Airtable } depuis les
// mappings de l'interface. Une clé dont la colonne n'est pas mappée est absente
// de l'objet (comme un field_map incomplet) — le sync la traite alors comme non
// mappée plutôt que d'écrire NULL.
export function fieldMapFromUi(erpTable, plan) {
  const byColumn = uiFieldNameByColumn(erpTable)
  const out = {}
  for (const [key, column] of Object.entries(plan)) {
    const name = byColumn.get(column)
    if (name) out[key] = name
  }
  return out
}

// ── Retrait du field_map « cœur » d'un module (une seule fois par module) ───
//
// Reprise du field_map existant vers airtable_field_mappings AVANT de
// l'effacer : sans ça, l'import perdrait, au premier démarrage suivant le
// déploiement, tout ce que le field_map nommait (numéro de suivi, statut,
// abonnement…).
//
// Idempotente par construction : la reprise n'a lieu que si un field_map existe
// encore, et elle l'efface dans la même transaction. Un champ démappé plus tard
// dans l'interface n'est donc jamais ressuscité.
//
// `spec` :
//   module        clé du module write-back (porte les sens `dyn:<colonne>`)
//   erpTable      table ERP alimentée
//   plan          clé logique → colonne ERP (le <MODULE>_FIELD_MAP_PLAN)
//   readMap()     → { field_map } brut, ou rien si le module n'en a plus
//   clearMap()    efface le field_map en base
//   linkTargets   colonne ERP → table ERP cible, pour les champs lien
//   pushColumns   colonnes à semer en 'both' (celles qui étaient réécrites vers
//                 Airtable du temps du field_map — les mappings dynamiques sont
//                 'pull' par défaut, sans ce seed le write-back s'arrêterait en
//                 silence)
//   columnOptions colonne ERP → options du mapping (source calculée, choix d'un
//                 select…), fusionnées avec le link_target_table éventuel
//   after(helpers) nettoyage additionnel, DANS la même transaction
function retireCoreFieldMap(spec) {
  const { module, erpTable, plan, linkTargets = {}, pushColumns = [], columnOptions = {} } = spec
  const cfg = spec.readMap()
  if (!cfg?.field_map) return { migrated: 0 }

  let map = null
  try { map = JSON.parse(cfg.field_map) } catch { map = null }
  const entries = map && typeof map === 'object'
    ? Object.entries(plan).filter(([key]) => typeof map[key] === 'string' && map[key])
    : []

  // Blob présent mais sans aucune clé exploitable (`'{}'` laissé par une
  // ancienne version de la page Connecteurs) : il n'y a rien à reprendre, donc
  // rien à nettoyer non plus. On l'efface et on s'arrête AVANT `after` — sinon
  // un nettoyage à usage unique (ex. mise à la corbeille d'un doublon) se
  // rejouerait à chaque démarrage et re-supprimerait un champ restauré.
  if (!entries.length) {
    spec.clearMap()
    return { migrated: 0 }
  }

  const liveCols = new Set(db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name))
  const existing = db.prepare(
    'SELECT column_name, airtable_field_id FROM airtable_field_mappings WHERE erp_table=?'
  ).all(erpTable)
  const byColumn = new Map(existing.map(r => [r.column_name, r]))

  const insert = db.prepare(`
    INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `)
  const takeOver = db.prepare(`
    UPDATE airtable_field_mappings
    SET airtable_field_id=?, airtable_field_name=?, options=?, import_disabled=0,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table=? AND column_name=?
  `)
  const seedDirection = db.prepare(`
    INSERT OR IGNORE INTO airtable_field_directions (module, field_key, direction)
    VALUES (?, ?, 'both')
  `)

  return db.transaction(() => {
    let migrated = 0
    for (const [key, column] of entries) {
      if (!liveCols.has(column)) continue
      const atField = map[key]
      const target = linkTargets[column]
      const options = JSON.stringify({
        ...(columnOptions[column] || {}),
        ...(target ? { link_target_table: target } : {}),
      })
      const row = byColumn.get(column)
      if (!row) {
        // `core_<colonne>` : id de champ Airtable synthétique. Les métadonnées
        // réelles ne sont pas disponibles au démarrage (appel réseau) et tous
        // les chemins qui comptent apparient par NOM (mapping-data, twinDefs du
        // sync, POST airtable-field-mapping).
        insert.run(newRecordId(), module, erpTable, `core_${column}`, atField, column, options)
        migrated++
      } else if (String(row.airtable_field_id || '').startsWith('native_')) {
        takeOver.run(`core_${column}`, atField, options, erpTable, column)
        migrated++
      }
      // Ligne de mapping déjà posée par l'utilisateur : elle fait foi, on n'y touche pas.
    }
    for (const column of pushColumns) {
      if (liveCols.has(column)) seedDirection.run(module, `dyn:${column}`)
    }
    if (spec.after) spec.after({ liveCols, byColumn, entries, map })
    spec.clearMap()
    if (migrated) console.log(`🔁 ${module} : ${migrated} mapping(s) cœur repris dans /champs/${erpTable}`)
    return { migrated }
  })()
}

// ── Envois ──────────────────────────────────────────────────────────────────
const ENVOIS_LINK_TARGETS = { order_id: 'orders', address_id: 'adresses' }

// Colonnes dont le sens de sync était 'both' par défaut du temps du field_map
// (clés scalaires hors skipKeys du write-back envois).
const ENVOIS_PUSH_COLUMNS = ['tracking_number', 'carrier', 'status', 'shipped_at', 'notes']

export function retireEnvoisCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'envois',
    erpTable: 'shipments',
    plan: ENVOIS_FIELD_MAP_PLAN,
    linkTargets: ENVOIS_LINK_TARGETS,
    pushColumns: ENVOIS_PUSH_COLUMNS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='envois'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='envois'").run(),
  })
}

// ── Commandes ───────────────────────────────────────────────────────────────
const ORDERS_LINK_TARGETS = {
  company_id: 'companies',
  project_id: 'projects',
  address_id: 'adresses',
}

// Seules colonnes réellement réécrivables vers Airtable côté commandes :
//   • Notes         → champ multilineText, déjà 'both' du temps du field_map ;
//   • Priorité      → singleSelect (Urgent / Ultra urgent) ;
//   • Abonnement    → singleSelect Oui/Non, via le codec de airtableWriteback.
// « Statut » et « # de commande » sont des champs FORMULE dans Airtable : un
// PATCH dessus renvoie 422, ils restent en import seul (cf. `neverPush`).
const ORDERS_PUSH_COLUMNS = ['notes', 'priority', 'is_subscription']

// Options des mappings repris. `source` calculée = le champ est produit par
// Airtable (formule) : formFieldCatalog l'écarte alors du formulaire de
// création, et l'UI ne le présente pas comme saisissable.
const ORDERS_COLUMN_OPTIONS = {
  order_number: { source: 'formula' },
  status: {
    source: 'formula',
    choices: ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter',
      'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé',
      'JWT-config', 'Drop ship seulement', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'],
  },
  priority: { choices: ['Urgent', 'Ultra urgent'] },
}

// Le champ Airtable « Abonnement » était mappé DEUX FOIS : par la clé cœur
// `is_subscription` (colonne 0/1 qui porte toute la logique métier — QuickBooks,
// dashboards, constat de revenu) et par une colonne dynamique `abonnement`
// (texte Oui/Non). Cette seconde n'a jamais été alimentée : le sync dynamique
// saute tout champ Airtable nommé dans le field_map cœur. La reprise garde la
// colonne qui compte et met le doublon à la corbeille — colonne SQL conservée,
// donc restaurable.
function retireAbonnementDuplicate() {
  const dup = db.prepare(
    "SELECT id FROM airtable_field_mappings WHERE erp_table='orders' AND column_name='abonnement'"
  ).get()
  if (dup) {
    db.prepare(
      "UPDATE airtable_field_mappings SET import_disabled=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
    ).run(dup.id)
  }
  db.prepare(`
    UPDATE custom_fields
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table='orders' AND column_name='abonnement' AND deleted_at IS NULL
  `).run()
}

export function retireOrdersCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'orders',
    erpTable: 'orders',
    plan: ORDERS_FIELD_MAP_PLAN,
    linkTargets: ORDERS_LINK_TARGETS,
    pushColumns: ORDERS_PUSH_COLUMNS,
    columnOptions: ORDERS_COLUMN_OPTIONS,
    readMap: () => db.prepare('SELECT field_map_orders AS field_map FROM airtable_orders_config').get(),
    clearMap: () => db.prepare('UPDATE airtable_orders_config SET field_map_orders=NULL').run(),
    after: retireAbonnementDuplicate,
  })
}
