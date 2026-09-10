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

// Clé logique du sync assemblages → colonne ERP de `assemblages` qui la porte.
// `assembly_points` n'a jamais été mappé (la colonne existe, le field_map ne la
// nommait pas) : le plan la déclare quand même, pour qu'elle devienne mappable
// depuis /champs/assemblages comme les trois autres.
export const ASSEMBLAGES_FIELD_MAP_PLAN = {
  product:         'product_id',
  qty_produced:    'qty_produced',
  assembled_at:    'assembled_at',
  assembly_points: 'assembly_points',
}

// Clé logique du sync nomenclature (BOM) → colonne ERP de `bom_items`.
// `ref_des` n'a jamais été mappé (la colonne existe, le field_map ne la nommait
// pas) : le plan la déclare quand même, pour qu'elle devienne mappable depuis
// /champs/bom_items comme les trois autres (même cas que `assembly_points`).
export const BOM_FIELD_MAP_PLAN = {
  product:      'product_id',
  component:    'component_id',
  qty_required: 'qty_required',
  ref_des:      'ref_des',
}

// Clé logique du sync pièces → colonne ERP de `products` qui la porte.
// `image` est la seule clé dont le nom diffère de sa colonne : le champ Airtable
// est une pièce jointe, l'ERP en garde le chemin de la copie locale (image_url).
export const PIECES_FIELD_MAP_PLAN = {
  name_fr:                 'name_fr',
  name_en:                 'name_en',
  sku:                     'sku',
  type:                    'type',
  unit_cost:               'unit_cost',
  price_cad:               'price_cad',
  stock_qty:               'stock_qty',
  min_stock:               'min_stock',
  supplier:                'supplier',
  procurement_type:        'procurement_type',
  weight_lbs:              'weight_lbs',
  image:                   'image_url',
  assembly_status:         'assembly_status',
  finished_min_stock:      'finished_min_stock',
  projected_available_qty: 'projected_available_qty',
  producible_qty:          'producible_qty',
  supplier_link:           'supplier_link',
}

// Clé logique du sync employés → colonne ERP de `employees` qui la porte.
// Le field_map « cœur » du module est vide depuis longtemps (aucune clé en
// base) : les colonnes cœur ne s'importaient donc plus, et rien dans l'app ne
// permettait de les remapper — le module n'a jamais eu de modale de mapping
// cœur (pas d'entrée dans CORE_FIELD_SPECS). Avec ce plan, chaque champ se
// branche sur son champ Airtable depuis /champs/employees, comme partout
// ailleurs, et le sync continue de raisonner en clés logiques (transformations
// empBool / empNum, gardes `requireAny` et `defaults` inchangées).
export const EMPLOYEES_FIELD_MAP_PLAN = {
  first_name:            'first_name',
  last_name:             'last_name',
  email_work:            'email_work',
  email_personal:        'email_personal',
  phone_work:            'phone_work',
  phone_personal:        'phone_personal',
  birth_date:            'birth_date',
  hire_date:             'hire_date',
  matricule:             'matricule',
  active:                'active',
  gender:                'gender',
  address:               'address',
  emergency_contact:     'emergency_contact',
  end_date:              'end_date',
  office_key:            'office_key',
  insurance_id:          'insurance_id',
  nethris_username:      'nethris_username',
  is_salesperson:        'is_salesperson',
  is_consultant:         'is_consultant',
  accounting_department: 'accounting_department',
  hours_per_week:        'hours_per_week',
  last_raise_date:       'last_raise_date',
  group_insurance:       'group_insurance',
  address_verified:      'address_verified',
  banking_info:          'banking_info',
  issues:                'issues',
  peer_reviews:          'peer_reviews',
}

// Clé logique du sync paies → colonne ERP de `paies` qui la porte.
// `csv` et `period_range` en sont sorties (migration 051, demande depuis
// /champs/paies) : `csv` avec sa colonne (droppée, aucun consommateur),
// `period_range` en gardant `period_start` intacte — colonne interne encore
// alimentée par `paieTimesheetImport` (règle des 14 jours), juste démappée
// d'Airtable.
export const PAIES_FIELD_MAP_PLAN = {
  number:                     'number',
  period_end:                 'period_end',
  status:                     'status',
  nb_holiday_days:            'nb_holiday_days',
  total_with_charges_and_reimb: 'total_with_charges_and_reimb',
  timesheets_deadline:        'timesheets_deadline',
  includes_hourly:            'includes_hourly',
  includes_mileage:           'includes_mileage',
  includes_expense_reimb:     'includes_expense_reimb',
  includes_paid_leave:        'includes_paid_leave',
  includes_holiday_hours:     'includes_holiday_hours',
  includes_sales_commissions: 'includes_sales_commissions',
  timesheets_sent:            'timesheets_sent',
}

// Clé logique du sync contacts → colonne ERP de `contacts` qui la porte.
// Les 6 clés du field_map cœur retiré (Prénom, Nom, Email, Phone number,
// Entreprise, Langue) plus `mobile` et `notes` : le field_map ne les nommait
// pas, mais leurs colonnes existent et le plan cœur du miroir sait les
// résoudre — les déclarer les rend mappables depuis /champs/contacts comme les
// autres (même cas que `assembly_points` des assemblages).
export const CONTACTS_FIELD_MAP_PLAN = {
  first_name: 'first_name',
  last_name:  'last_name',
  email:      'email',
  phone:      'phone',
  mobile:     'mobile',
  company:    'company_id',
  language:   'language',
  notes:      'notes',
}

// Clé logique du sync projets → colonne ERP de `projects` qui la porte.
// EXACTEMENT les deux clés du field_map cœur retiré — les seules qui étaient
// annoncées « gérées en code, non modifiables ici » au bas de /champs/projects :
// « ID » (le numéro de projet) et « Client final » (l'entreprise liée).
//
// Les autres colonnes du plan cœur (valeur, mensuel, nb serres, fermeture,
// notes) ne sont VOLONTAIREMENT pas déclarées : le field_map ne les nommait pas,
// elles sont déjà importées par leur mapping dynamique (réglable dans
// /champs/projects depuis toujours). Les ajouter ici les ferait basculer sur le
// chemin cœur, donc changerait le convertisseur qui les écrit — un effet de bord
// que la demande ne réclame pas.
export const PROJETS_FIELD_MAP_PLAN = {
  name:    'name',
  company: 'company_id',
}

// Clé logique du sync articles de retour → colonne ERP de `return_items` qui la
// porte. Les 12 clés qui restent du field_map cœur — « Produit à envoyer » est
// partie avec sa colonne (migration 046).
//
// Quatre d'entre elles sont des LIENS (retour, numéro de série, entreprise,
// produit à recevoir) : la colonne ERP porte un id Boréal, résolu par le plan
// cœur du miroir. Elles restent dans le plan — c'est ce qui les rend remappables
// — mais elles ne sont PAS adoptées en champs (cf. nativeFieldConversions.js).
export const RETOUR_ITEMS_FIELD_MAP_PLAN = {
  return:              'return_id',
  serial:              'serial_id',
  company:             'company_id',
  product_to_receive:  'product_id',
  return_reason:       'return_reason',
  return_reason_notes: 'return_reason_notes',
  problem_category:    'problem_category',
  action:              'action',
  received_at:         'received_at',
  received_by:         'received_by',
  analysis_notes:      'analysis_notes',
  analyzed_by:         'analyzed_by',
}

// Clé logique du sync numéros de série → colonne ERP de `serial_numbers` qui la
// porte. EXACTEMENT les 10 clés du field_map cœur retiré (cf.
// retireSerialsCoreFieldMap) : c'est ce qui était annoncé « géré en code, non
// modifiable ici » au bas de /champs/serial_numbers.
//
// Trois d'entre elles sont des LIENS (produit, entreprise, item de commande) :
// la colonne ERP porte un id Boréal, résolu par le plan cœur du miroir. Elles
// restent dans le plan — c'est ce qui les rend remappables — mais ne sont PAS
// adoptées en champs (cf. nativeFieldConversions.js).
export const SERIALS_FIELD_MAP_PLAN = {
  serial:               'serial',
  product:              'product_id',
  company:              'company_id',
  order_item:           'order_item_id',
  address:              'address',
  manufacture_date:     'manufacture_date',
  last_programmed_date: 'last_programmed_date',
  manufacture_value:    'manufacture_value',
  status:               'status',
  notes:                'notes',
}

// Valeurs de « Phase du cycle de vie » côté ERP, dans leur orthographe
// canonique. Elles reprennent EXACTEMENT les valeurs de la table de
// correspondance `phase_choices` du field_map cœur retiré (dont la seule
// traduction réelle était « Solution Aware » d'Airtable → « Solution aware »
// ici), plus « Others » qu'Airtable envoie tel quel. Le miroir s'en sert pour
// normaliser la casse à l'import ; une phase inconnue de cette liste passe,
// elle, telle quelle — comme le faisait `phase_choices`.
export const COMPANY_PHASES = [
  'Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead',
  'Quote Sent', 'Customer', 'Not a Client Anymore', 'Others',
]

// Clé logique du sync entreprises → colonne ERP de `companies` qui la porte.
// Les 2 dernières clés du field_map cœur du CRM (« Entreprise » → le nom,
// « Phase du cycle de vie ») plus 6 colonnes que le field_map ne nommait pas :
// leurs colonnes existent et le plan cœur du miroir sait les résoudre — les
// déclarer les rend mappables depuis /champs/companies comme les autres (même
// cas que `mobile`/`notes` des contacts).
// `phone`, `website` et `type` n'y sont plus : colonnes droppées (migration 045).
export const COMPANIES_FIELD_MAP_PLAN = {
  name:            'name',
  lifecycle_phase: 'lifecycle_phase',
  email:           'email',
  address:         'address',
  city:            'city',
  province:        'province',
  country:         'country',
  notes:           'notes',
}

// Deux champs Airtable que le sync des paies LIT sans qu'aucune colonne ERP les
// porte : ils servent uniquement à reconstituer le total attendu quand le champ
// « incluant les remboursements » n'est pas encore rempli. Faute de colonne, ils
// ne peuvent pas avoir de ligne dans /champs/paies (même cas que la clé `items`
// des envois) — ils restent donc désignés par leur nom, celui qu'avait le
// field_map cœur retiré.
export const PAIES_UNMAPPED_AIRTABLE_FIELDS = {
  total_excl_reimb: 'Total de la paie incluant les remises aux organismes et excluant les remboursements de dépenses',
  expense_reimb_total: 'Remboursements de dépenses',
}

// Colonne ERP → nom du champ Airtable, tel que réglé dans /champs/:table.
// Les defs `native_*` (whitelist interne posée par ensureNativeFieldDefs) sont
// écartées : leur `airtable_field_name` est un LIBELLÉ ERP, pas un champ
// Airtable. Les produits en ont une par colonne native : la reprise ci-dessous
// les convertit en vrais mappings (`core_<colonne>`), ce qui les rend enfin
// visibles ici — une def restée `native_` continue, elle, d'être ignorée.
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

// Rattrapage idempotent des options d'un mapping repris. `retireCoreFieldMap`
// ne pose les `columnOptions` qu'au moment où il MIGRE : une fois le field_map
// effacé, il ne fait plus rien — un oubli (ou un ajout) d'option resterait donc
// sans effet sur les lignes déjà en place. Or `native_field_type` n'est pas
// cosmétique : c'est la seule chose qui dise au picker de /champs le type de la
// colonne ERP quand elle n'a pas de champ adopté. Sans lui, une colonne
// numérique passe pour du texte et le picker n'offre AUCUN champ Airtable
// numérique au remappage.
//
// Fusion, jamais écrasement : seules les clés déclarées sont posées, et
// uniquement sur les defs reprises du cœur (`core_*`) — un mapping choisi par
// l'utilisateur ne nous appartient pas.
export function ensureCoreMappingOptions(erpTable, columnOptions) {
  const rows = db.prepare(
    'SELECT id, airtable_field_id, column_name, options FROM airtable_field_mappings WHERE erp_table=?'
  ).all(erpTable)
  const update = db.prepare(
    "UPDATE airtable_field_mappings SET options=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
  )
  let fixed = 0
  for (const row of rows) {
    if (!String(row.airtable_field_id || '').startsWith('core_')) continue
    const declared = columnOptions[row.column_name]
    if (!declared) continue
    let opts = {}
    try { opts = JSON.parse(row.options || '{}') } catch { opts = {} }
    const next = { ...opts, ...declared }
    if (JSON.stringify(next) === JSON.stringify(opts)) continue
    update.run(JSON.stringify(next), row.id)
    fixed++
  }
  return { fixed }
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

// ── Assemblages ─────────────────────────────────────────────────────────────
// Trois clés cœur (« Produit », « Quantités fabriqués », « Date ») : elles
// étaient annoncées « gérées en code, non modifiables ici » en bas de
// /champs/assemblages. Aucune colonne à pousser — le module est en import seul
// (pas de write-back, pas d'édition dans l'ERP).
const ASSEMBLAGES_LINK_TARGETS = { product_id: 'products' }

// `native_field_type` sur le seul lien « Produit » : la colonne n'a pas de champ
// adopté (une ligne custom_fields active en ferait une colonne de tableau
// remplie d'ids bruts), donc rien d'autre ne dirait son type au picker de
// /champs/assemblages — il la prenait pour du texte, offrait n'importe quel
// champ Airtable (formules, « Semaine »…) et n'exigeait plus la table cible :
// un remappage effaçait `link_target_table` et des record ids Airtable bruts
// seraient atterris dans `product_id`. Les deux clés scalaires (quantité, date)
// sont adoptées en champs (nativeFieldConversions.js) : leur type vient de là.
const ASSEMBLAGES_COLUMN_OPTIONS = {
  product_id: { native_field_type: 'link' },
}

export function retireAssemblagesCoreFieldMap() {
  const out = retireCoreFieldMap({
    module: 'assemblages',
    erpTable: 'assemblages',
    plan: ASSEMBLAGES_FIELD_MAP_PLAN,
    linkTargets: ASSEMBLAGES_LINK_TARGETS,
    columnOptions: ASSEMBLAGES_COLUMN_OPTIONS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='assemblages'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='assemblages'").run(),
  })
  // La reprise a eu lieu (2026-09-06) avant que ce type soit déclaré : on le
  // repose sur la ligne existante, sinon « Produit » resterait du texte aux yeux
  // du picker.
  ensureCoreMappingOptions('assemblages', ASSEMBLAGES_COLUMN_OPTIONS)
  return out
}

// ── Produits (module « pieces ») ────────────────────────────────────────────
// 17 clés cœur, dont 11 avaient déjà leur ligne de mapping en `native_*` (la
// whitelist d'ensureNativeFieldDefs) : la reprise les transforme en vrais
// mappings, les 6 autres sont créées. Aucune colonne à pousser — le module est
// en import seul (aucune entrée dans WRITEBACK_MODULES), donc rien à semer en
// 'both'. Aucun champ lien non plus : les produits n'importent aucune FK par le
// cœur.
//
// `source` calculée = le champ est produit par Airtable (formule / rollup) :
// c'est ce que dit déjà la def dynamique jumelle de ces colonnes, et ça évite de
// proposer à la saisie une valeur qu'Airtable réécrit au sync suivant.
const PIECES_COLUMN_OPTIONS = {
  assembly_status:         { source: 'formula' },
  projected_available_qty: { source: 'formula' },
  producible_qty:          { source: 'rollup' },
  // Le champ « Image » est une pièce jointe Airtable dont l'ERP ne garde que le
  // chemin de la copie locale (cf. piecesPrepareImages) : la colonne porte une
  // URL, comme le disait déjà la def native reprise ici.
  image_url:               { format: 'url' },
}

export function retirePiecesCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'pieces',
    erpTable: 'products',
    plan: PIECES_FIELD_MAP_PLAN,
    columnOptions: PIECES_COLUMN_OPTIONS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='pieces'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='pieces'").run(),
  })
}

// ── Paies ───────────────────────────────────────────────────────────────────
// 13 clés cœur restantes (`csv` et `period_range` retirées — migration 051).
// Le module est le premier à la fois importé ET réécrit vers Airtable : les
// colonnes que l'ERP modifie doivent donc repartir en 'both', sinon le
// write-back s'arrêterait en silence (les mappings dynamiques sont 'pull' par
// défaut).
const PAIES_PUSH_COLUMNS = [
  'number', 'period_end', 'status', 'nb_holiday_days', 'total_with_charges_and_reimb',
  'timesheets_deadline', 'timesheets_sent', 'includes_hourly', 'includes_mileage',
  'includes_expense_reimb', 'includes_paid_leave', 'includes_holiday_hours',
  'includes_sales_commissions',
]

export function retirePaiesCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'paies',
    erpTable: 'paies',
    plan: PAIES_FIELD_MAP_PLAN,
    pushColumns: PAIES_PUSH_COLUMNS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='paies'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='paies'").run(),
  })
}

// ── Contacts ────────────────────────────────────────────────────────────────
// Les 6 champs annoncés « gérés en code, non modifiables ici » au bas de
// /champs/contacts : Prénom, Nom, Email, Phone number, Entreprise, Langue. Leur
// field_map ne vit pas dans airtable_module_config mais dans le singleton du
// CRM (`airtable_sync_config.field_map_contacts`) — d'où le readMap/clearMap
// dédié. Les deux routes qui écrivaient ce blob (PUT /airtable/sync-config et
// /airtable/contacts-config) ne l'écrivent plus : le laisser dans l'UPSERT
// ressusciterait le field_map et re-verrouillerait les 6 champs.
//
// `module` = 'airtable_contacts' : c'est sous cette clé que vivent DÉJÀ les
// mappings dynamiques des contacts (dynamicFieldsKey du miroir), et
// uiFieldNameByColumn lit par table, pas par module.
//
// Aucune colonne à pousser : les contacts n'ont pas de write-back (absent de
// WRITEBACK_MODULES) — le sync entrant est la seule écriture Airtable.
const CONTACTS_LINK_TARGETS = { company_id: 'companies' }

// `format: 'email'` / `'phone'` : ce que la colonne porte, pour que la saisie et
// le picker de mapping ne les prennent pas pour du texte quelconque. Les deux
// seuls choix réels de « Langue » côté ERP sont French / English (le sync
// normalise Français/Anglais vers ces deux valeurs, cf. CORE_PLANS.contacts).
const CONTACTS_COLUMN_OPTIONS = {
  email:    { format: 'email' },
  phone:    { format: 'phone' },
  mobile:   { format: 'phone' },
  language: { choices: ['French', 'English'] },
}

export function retireContactsCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'airtable_contacts',
    erpTable: 'contacts',
    plan: CONTACTS_FIELD_MAP_PLAN,
    linkTargets: CONTACTS_LINK_TARGETS,
    columnOptions: CONTACTS_COLUMN_OPTIONS,
    readMap: () => db.prepare('SELECT field_map_contacts AS field_map FROM airtable_sync_config').get(),
    clearMap: () => db.prepare('UPDATE airtable_sync_config SET field_map_contacts=NULL').run(),
  })
}

// ── Entreprises ─────────────────────────────────────────────────────────────
// Les 2 champs qui restaient annoncés « gérés en code, non modifiables ici » au
// bas de /champs/companies : « Entreprise » (le nom) et « Phase du cycle de
// vie ». Les trois autres (« Phone number », « URL », « Type ») ont été
// détruits avec leurs colonnes par la migration 045 ; ces deux-là portent trop
// de fonctions pour être droppés (le nom est lu par une quarantaine de fichiers
// et par 3 champs calculés ; la phase pilote la file de relance des appels de
// qualification, la carte des clients et le suivi d'installation) — c'est donc
// la voie des contacts qui s'applique : on détruit le CODAGE EN DUR, pas la
// donnée.
//
// Même singleton que les contacts (`airtable_sync_config.field_map_companies`),
// d'où le readMap/clearMap dédié ; les trois routes qui écrivaient ce blob
// (PUT /airtable/sync-config, /airtable/crm-config, /airtable/companies-config)
// ne l'écrivent plus, sinon la première sauvegarde de la page Connecteurs le
// ressusciterait et re-verrouillerait les deux champs.
//
// `module` = 'airtable_companies' : c'est sous cette clé que vivent DÉJÀ les
// mappings dynamiques des entreprises (dynamicFieldsKey du miroir).
//
// Aucune colonne à pousser : les entreprises n'ont pas de write-back (absentes
// de WRITEBACK_MODULES) — le sync entrant est la seule écriture Airtable.
// Aucun champ lien non plus : le cœur des entreprises n'importe aucune FK.
//
// En pratique les deux colonnes ont déjà leur ligne de mapping (jumelle semée
// par le webhook, dormante tant que le field_map les réclamait) : la reprise
// n'a donc rien à créer, elle les laisse faire foi — d'où `migrated: 0` au
// démarrage, ce qui est le bon résultat.
const COMPANIES_COLUMN_OPTIONS = {
  // « Entreprise » est une FORMULE dans Airtable (ce que dit déjà la ligne de
  // mapping en place) : la présenter comme saisissable serait faux.
  name:            { source: 'formula' },
  email:           { format: 'email' },
  lifecycle_phase: { choices: COMPANY_PHASES },
}

export function retireCompaniesCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'airtable_companies',
    erpTable: 'companies',
    plan: COMPANIES_FIELD_MAP_PLAN,
    columnOptions: COMPANIES_COLUMN_OPTIONS,
    readMap: () => db.prepare('SELECT field_map_companies AS field_map FROM airtable_sync_config').get(),
    clearMap: () => db.prepare('UPDATE airtable_sync_config SET field_map_companies=NULL').run(),
  })
}

// ── Projets ─────────────────────────────────────────────────────────────────
// Les 2 champs annoncés « gérés en code, non modifiables ici » au bas de
// /champs/projects : « ID » (le numéro de projet, colonne `name`) et
// « Client final » (l'entreprise liée, colonne `company_id`). Leur field_map vit
// dans le singleton des projets (`airtable_projets_config.field_map_projects`),
// d'où le readMap/clearMap dédié ; la route qui écrivait ce blob
// (PUT /airtable/projets-config) ne l'écrit plus, sinon la première sauvegarde
// de la page Connecteurs le ressusciterait et re-verrouillerait les deux champs.
//
// ATTENTION : la clé `name` est la garde d'insertion du sync (`require: ['name']`
// côté moteur de miroir). Démapper « ID » dans /champs/projects arrête donc
// l'import de NOUVEAUX projets — c'est le même comportement qu'avant, mais il
// est désormais entre les mains de l'utilisateur.
const PROJETS_LINK_TARGETS = { company_id: 'companies' }

// Aucune colonne à pousser :
//   • « ID » est une FORMULE Airtable — un PATCH dessus renvoie 422 (le
//     write-back l'écartait déjà, cf. isAirtableComputedKey) ;
//   • « Client final » est un champ lien, jamais réécrit (skipKeys du module).
// `native_field_type` : le type ERP de la colonne, que la def native portait
// dans ses options — la reprise les remplace, et sans lui /champs/projects
// prendrait `company_id` pour du texte et n'exigerait plus de table cible au
// remappage (les record IDs bruts atterriraient dans la colonne).
const PROJETS_COLUMN_OPTIONS = {
  name:       { source: 'formula', native_field_type: 'text' },
  company_id: { native_field_type: 'link' },
}

export function retireProjetsCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'projets',
    erpTable: 'projects',
    plan: PROJETS_FIELD_MAP_PLAN,
    linkTargets: PROJETS_LINK_TARGETS,
    columnOptions: PROJETS_COLUMN_OPTIONS,
    readMap: () => db.prepare('SELECT field_map_projects AS field_map FROM airtable_projets_config').get(),
    clearMap: () => db.prepare('UPDATE airtable_projets_config SET field_map_projects=NULL').run(),
  })
}

// ── Articles de retour ──────────────────────────────────────────────────────
// Les champs annoncés « gérés en code, non modifiables ici » au bas de
// /champs/return_items. Contrairement aux retours eux-mêmes (migration 037, où
// la donnée était morte et les colonnes ont été DROPPÉES), les colonnes des
// articles portent de la donnée vivante — jusqu'à 767 lignes remplies sur 767 —
// et sont le socle de la fiche retour : `company_id` est LA source de
// l'entreprise d'un retour depuis 037 (services/returnCompany.js), `serial_id`
// pilote le statut du numéro de série, `action` la commande de remplacement,
// `received_at` la réception. C'est donc la voie des contacts / entreprises /
// projets qui s'applique : on détruit le CODAGE EN DUR, pas la donnée.
//
// Les 4 clés lien gardent leur table cible : la colonne stocke déjà un id
// Boréal (écrit par le plan cœur du miroir, pas par convertValue), la déclarer
// ne réécrit donc aucune valeur — elle rend seulement la table cible visible et
// exigée au remappage, sans quoi des record ids bruts pourraient y atterrir.
const RETOUR_ITEMS_LINK_TARGETS = {
  return_id:       'returns',
  serial_id:       'serial_numbers',
  company_id:      'companies',
  product_id:      'products',
}

// `native_field_type` sur les 4 liens SEULEMENT : eux n'ont pas de champ adopté
// (une ligne custom_fields active en ferait des colonnes de tableau remplies
// d'ids bruts), donc rien d'autre ne dirait leur type au picker de mapping — il
// les prendrait pour du texte et n'exigerait plus de table cible. Les 8 clés
// scalaires, elles, sont adoptées en champs (nativeFieldConversions.js) : leur
// type vient de là, et il fait foi.
const RETOUR_ITEMS_COLUMN_OPTIONS = {
  return_id:       { native_field_type: 'link' },
  serial_id:       { native_field_type: 'link' },
  company_id:      { native_field_type: 'link' },
  product_id:      { native_field_type: 'link' },
}

// Aucune colonne à pousser. Le module a bien un write-back, mais en
// `defaultDirection: 'pull'` : aucune des clés n'était réécrite vers Airtable
// (aucune ligne dans airtable_field_directions). Semer un 'both' ici allumerait
// un push que personne n'a demandé — le sens reste choisissable champ par champ
// dans /champs/return_items, comme avant.
export function retireRetourItemsCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'retour_items',
    erpTable: 'return_items',
    plan: RETOUR_ITEMS_FIELD_MAP_PLAN,
    linkTargets: RETOUR_ITEMS_LINK_TARGETS,
    columnOptions: RETOUR_ITEMS_COLUMN_OPTIONS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='retour_items'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='retour_items'").run(),
  })
}

// ── Numéros de série ────────────────────────────────────────────────────────
// Les 10 champs annoncés « gérés en code, non modifiables ici » au bas de
// /champs/serial_numbers. Même voie que les contacts / entreprises / projets /
// articles de retour : on détruit le CODAGE EN DUR, pas la donnée — ces colonnes
// portent 5 400 numéros de série, le statut pilote les écritures comptables de
// mouvement (serial_accounting_rules) et `manufacture_value` en est la base.
//
// Les 3 clés lien gardent leur table cible : la colonne stocke déjà un id Boréal
// (écrit par le plan cœur du miroir), la déclarer ne réécrit aucune valeur —
// elle rend seulement la table cible visible et exigée au remappage.
const SERIALS_LINK_TARGETS = {
  product_id:    'products',
  company_id:    'companies',
  order_item_id: 'order_items',
}

// Le module a un write-back (WRITEBACK_MODULES.serials) et ses clés cœur
// partaient en 'both' par défaut ; les mappings dynamiques, eux, sont 'pull' par
// défaut. Sans ce seed, la réécriture vers Airtable s'arrêterait en silence.
// `serial` en est exclu : « # de série » est une FORMULE Airtable, un PATCH
// dessus renvoie 422 (le write-back l'écartait déjà).
const SERIALS_PUSH_COLUMNS = [
  'status', 'notes', 'address', 'manufacture_date', 'last_programmed_date',
  'manufacture_value',
]

// `native_field_type` sur les 3 liens SEULEMENT : eux n'ont pas de champ adopté
// (une ligne custom_fields active en ferait des colonnes de tableau remplies
// d'ids bruts), donc rien d'autre ne dirait leur type au picker de mapping. Les
// 7 clés scalaires sont adoptées en champs (nativeFieldConversions.js) : leur
// type vient de là, et il fait foi.
const SERIALS_COLUMN_OPTIONS = {
  product_id:    { native_field_type: 'link' },
  company_id:    { native_field_type: 'link' },
  order_item_id: { native_field_type: 'link' },
  // « # de série » est calculé par Airtable : le présenter comme saisissable
  // serait faux (formFieldCatalog l'écarte alors du formulaire de création).
  serial:        { source: 'formula' },
}

export function retireSerialsCoreFieldMap() {
  return retireCoreFieldMap({
    module: 'serials',
    erpTable: 'serial_numbers',
    plan: SERIALS_FIELD_MAP_PLAN,
    linkTargets: SERIALS_LINK_TARGETS,
    pushColumns: SERIALS_PUSH_COLUMNS,
    columnOptions: SERIALS_COLUMN_OPTIONS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='serials'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='serials'").run(),
  })
}

// ── Nomenclature (BOM) ──────────────────────────────────────────────────────
// Le module n'avait AUCUN contrôle de champ : /champs/bom_items n'offrait pas de
// colonne « Champ Airtable », et ses 3 clés cœur (« Produit », « Pièces »,
// « QTY nécessaires ») ne se remappaient nulle part dans l'app. Même voie que
// les autres miroirs : on détruit le CODAGE EN DUR, pas la donnée — les colonnes
// portent la nomenclature de tous les produits assemblés (`buildable`, la
// priorité d'assemblage et le coût de fabrication en dépendent).
//
// Les 2 clés lien gardent leur table cible : la colonne stocke déjà un id Boréal
// (résolu par le plan cœur du miroir), la déclarer ne réécrit aucune valeur —
// elle rend seulement la table cible visible et exigée au remappage.
const BOM_LINK_TARGETS = {
  product_id:   'products',
  component_id: 'products',
}

// `native_field_type` sur les 4 colonnes : aucune n'a de champ adopté, donc rien
// d'autre ne dirait leur type au picker de mapping. Les deux liens y passeraient
// pour du texte et n'exigeraient plus de table cible (des record ids bruts
// pourraient y atterrir) ; « Qté requise » est un NOMBRE, et sans ça le picker
// n'offrait aucun champ Airtable numérique pour la remapper.
const BOM_COLUMN_OPTIONS = {
  product_id:   { native_field_type: 'link' },
  component_id: { native_field_type: 'link' },
  qty_required: { native_field_type: 'number' },
  ref_des:      { native_field_type: 'text' },
}

// Aucune colonne à pousser : le module est en import seul (absent de
// WRITEBACK_MODULES) — le sync entrant est la seule écriture Airtable.
export function retireBomCoreFieldMap() {
  const out = retireCoreFieldMap({
    module: 'bom',
    erpTable: 'bom_items',
    plan: BOM_FIELD_MAP_PLAN,
    linkTargets: BOM_LINK_TARGETS,
    columnOptions: BOM_COLUMN_OPTIONS,
    readMap: () => db.prepare("SELECT field_map FROM airtable_module_config WHERE module='bom'").get(),
    clearMap: () => db.prepare("UPDATE airtable_module_config SET field_map=NULL WHERE module='bom'").run(),
  })
  // La reprise a pu se faire avant que ces types soient déclarés : on les repose
  // sur les lignes existantes, sinon la colonne « Qté requise » resterait du
  // texte aux yeux du picker.
  ensureCoreMappingOptions('bom_items', BOM_COLUMN_OPTIONS)
  return out
}
