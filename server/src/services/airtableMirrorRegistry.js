/**
 * Registre du miroir Airtable — le remplissage et la lecture des deux tables
 * créées par la migration 004 (`airtable_mirrors`, `airtable_field_map`).
 *
 * Rôle. Rassembler en DONNÉES ce qui vit aujourd'hui dans neuf tables de config
 * et dans 206 clés codées en dur dans le code des fonctions de sync. Le registre
 * décrit le miroir ; il ne l'exécute pas encore — le sync continue de lire les
 * tables historiques jusqu'au moteur unique (palier 3). Ce module est donc, pour
 * l'instant, la source de vérité de la DESCRIPTION et rien d'autre.
 *
 * Deux moitiés, deux propriétaires. Le côté Airtable (quelles tables, quels
 * champs, quels types) est rafraîchi depuis les métadonnées à chaque passage.
 * Le côté décision (`erp_column`, `state`, `direction`, `exclude_reason`)
 * appartient à l'utilisateur : une ligne dont `decided_by='user'` n'est JAMAIS
 * réécrite par le remplissage automatique. Sans cette règle, le prochain
 * rafraîchissement effacerait silencieusement un arbitrage.
 *
 * Ce que le registre rend mesurable, et que rien ne mesurait :
 *   status='undecided'  tables Airtable sans décision (le contrat en exige zéro)
 *   state='unmapped'    champs sans décision
 *   state='core'        champs alimentés par un field_map codé en dur — la dette
 *                       du palier 3, invisible et non auditable par construction
 */

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { dynamicFieldDirection, writebackModuleForTable, pushableLinkColumn, pushOnlyColumns } from './airtableWriteback.js'

// ── Les miroirs connus ──────────────────────────────────────────────────────
//
// Reflète la configuration historique, éparpillée dans cinq tables. C'est la
// graine du registre : au premier remplissage, ces lignes deviennent
// `airtable_mirrors`, et cette constante ne sert plus qu'à retrouver la config
// legacy (base/table/field_map) pour le mapping des champs.
//
//   sync: 'full'       une fonction de sync complète existe (SYNC_FNS)
//         'links-only' seuls certains liens sont repris par webhook
//         'none'       configuré autrefois, plus branché — le miroir est figé
export const MIRROR_SEED = [
  { id: 'companies', erpTable: 'companies', sync: 'full',
    cfg: { table: 'airtable_sync_config', tableIdCol: 'companies_table_id', fieldMapCol: 'field_map_companies' } },
  { id: 'contacts', erpTable: 'contacts', sync: 'full',
    cfg: { table: 'airtable_sync_config', tableIdCol: 'contacts_table_id', fieldMapCol: 'field_map_contacts' } },
  { id: 'orders', erpTable: 'orders', sync: 'full', dependsOn: ['companies', 'projets'],
    cfg: { table: 'airtable_orders_config', tableIdCol: 'orders_table_id', fieldMapCol: 'field_map_orders' } },
  { id: 'order_items', erpTable: 'order_items', sync: 'full', dependsOn: ['orders'],
    cfg: { table: 'airtable_orders_config', tableIdCol: 'items_table_id', fieldMapCol: 'field_map_items' } },
  { id: 'projets', erpTable: 'projects', sync: 'full', dependsOn: ['companies'],
    cfg: { table: 'airtable_projets_config', tableIdCol: 'projects_table_id', fieldMapCol: 'field_map_projects' } },
  { id: 'pieces', erpTable: 'products', sync: 'full', module: 'pieces' },
  { id: 'achats', erpTable: 'purchases', sync: 'full', module: 'achats' },
  { id: 'billets', erpTable: 'tickets', sync: 'full', module: 'billets', dependsOn: ['companies', 'contacts'] },
  { id: 'serials', erpTable: 'serial_numbers', sync: 'full', module: 'serials', dependsOn: ['pieces'] },
  { id: 'envois', erpTable: 'shipments', sync: 'full', module: 'envois', dependsOn: ['orders', 'adresses'] },
  { id: 'retours', erpTable: 'returns', sync: 'full', module: 'retours', dependsOn: ['companies'] },
  { id: 'retour_items', erpTable: 'return_items', sync: 'full', module: 'retour_items', dependsOn: ['retours'] },
  { id: 'adresses', erpTable: 'adresses', sync: 'full', module: 'adresses', dependsOn: ['companies', 'contacts'] },
  { id: 'serial_changes', erpTable: 'serial_state_changes', sync: 'full', module: 'serial_changes', dependsOn: ['serials'] },
  { id: 'assemblages', erpTable: 'assemblages', sync: 'full', module: 'assemblages' },
  { id: 'soumissions', erpTable: 'soumissions', sync: 'full', module: 'soumissions', dependsOn: ['companies', 'projets'] },
  { id: 'bom', erpTable: 'bom_items', sync: 'full', module: 'bom', dependsOn: ['pieces'] },
  { id: 'stock_movements', erpTable: 'stock_movements', sync: 'full', module: 'stock_movements', dependsOn: ['pieces'] },
  // `purgeOrphans: false` — l'ERP est la source de vérité des prospects : une
  // ligne supprimée dans Airtable ne doit pas effacer la fiche, ni la mémoire
  // du DM déjà envoyé (ce qui rouvrirait la porte à un second contact).
  { id: 'instagram', erpTable: 'instagram_prospects', sync: 'full', module: 'instagram', purgeOrphans: false },
  { id: 'employees', erpTable: 'employees', sync: 'full', module: 'employees' },
  { id: 'paies', erpTable: 'paies', sync: 'full', module: 'paies', dependsOn: ['employees'] },
  { id: 'paie_items', erpTable: 'paie_items', sync: 'full', module: 'paie_items', dependsOn: ['paies'] },
  // Débranchés du sync Airtable au profit de Stripe/QuickBooks : la divergence
  // y est attendue, pas accidentelle. 'paused' le dit, au lieu de le taire.
  { id: 'factures', erpTable: 'factures', sync: 'links-only', module: 'factures' },
  { id: 'abonnements', erpTable: 'subscriptions', sync: 'none', module: 'abonnements' },
]

const STATUS_BY_SYNC = { full: 'mirrored', 'links-only': 'paused', none: 'paused' }

// Types Airtable calculés par Airtable : lecture seule de notre côté.
export const COMPUTED_AT_TYPES = new Set([
  'formula', 'rollup', 'count', 'lookup', 'multipleLookupValues',
  'autoNumber', 'createdTime', 'lastModifiedTime', 'lastModifiedBy', 'createdBy',
  'button', 'externalSyncSource',
])

// Types dont la valeur stockée côté ERP n'est structurellement pas la valeur
// Airtable : liens (recIds ↔ uuid) et pièces jointes (URL miroir locale).
const LINK_AT_TYPES = new Set(['multipleRecordLinks'])
const ATTACHMENT_AT_TYPES = new Set(['multipleAttachments'])

export const CORE_UNCOMPARABLE_REASON =
  'field_map cœur — transformation dans le code, non auditable'

// ── Pièces jointes image ────────────────────────────────────────────────────
//
// Reprise de `imageAttachmentsOf()` (airtableAutoSync.js). Le sync ne stocke pas
// l'URL Airtable d'une pièce jointe image : il recopie le fichier sous
// uploads/attachments/airtable et garde un chemin local stable. Un tel champ
// n'est donc jamais comparable — et il ne se reconnaît PAS à son type Airtable :
// une image atteinte par lookup a le type `multipleLookupValues`. Il faut
// regarder les valeurs, ce que fait le rafraîchissement sur un échantillon.
const IMAGE_FILENAME_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif)$/i

export function hasImageAttachments(val) {
  if (!Array.isArray(val)) return false
  const flat = val.flat ? val.flat() : val
  if (!flat.length) return false
  for (const att of flat) {
    if (!att || typeof att !== 'object' || typeof att.url !== 'string') return false
    const isImage = typeof att.type === 'string'
      ? att.type.startsWith('image/')
      : IMAGE_FILENAME_RE.test(att.filename || '')
    if (!isImage) return false
  }
  return true
}

// ── Accès base ──────────────────────────────────────────────────────────────

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function liveColumns(table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)) }
  catch { return new Set() }
}

// Même critère que `notNullColumns()` de airtableAutoSync.js. Le registre doit
// classer un champ « écrit » exactement quand le sync l'écrit, sinon il décrit
// un miroir qui n'existe pas.
function notNullColumns(table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all()
      .filter(c => c.notnull === 1).map(c => c.name))
  } catch { return new Set() }
}

/** base_id / table_id / field_map d'un miroir, lus dans la config historique. */
export function resolveLegacyConfig(mirror) {
  if (mirror.module) {
    const row = db.prepare(
      'SELECT base_id, table_id, field_map, last_synced_at FROM airtable_module_config WHERE module=?'
    ).get(mirror.module)
    if (!row) return null
    return { baseId: row.base_id, tableId: row.table_id, fieldMapRaw: row.field_map, lastSyncedAt: row.last_synced_at }
  }
  const { table, tableIdCol, fieldMapCol } = mirror.cfg
  if (!tableExists(table)) return null
  const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()
  if (!row) return null
  return {
    baseId: row.base_id,
    tableId: row[tableIdCol],
    fieldMapRaw: row[fieldMapCol],
    lastSyncedAt: row.last_synced_at,
  }
}

export function parseFieldMap(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

// ── Classification d'un champ ───────────────────────────────────────────────

function roleOf(atType) {
  if (LINK_AT_TYPES.has(atType)) return 'link'
  if (ATTACHMENT_AT_TYPES.has(atType)) return 'attachment'
  if (COMPUTED_AT_TYPES.has(atType)) return 'computed'
  return 'scalar'
}

/**
 * Classe chaque champ d'une table Airtable en reproduisant fidèlement la
 * sélection de `updateDynamicFields()` : quels champs le sync écrit réellement,
 * et pour les autres, POURQUOI il ne les écrit pas. Toute la valeur du registre
 * tient dans cette fidélité — un champ décrit « mirroré » à tort fait croire à
 * un miroir vérifié qui ne l'est pas.
 *
 * Retourne { fields, orphanMappings, coreKeyCount }.
 */
export function classifyFields(mirror, atTable, fieldMap) {
  const erpTable = mirror.erpTable
  const cols = liveColumns(erpTable)
  const notNull = notNullColumns(erpTable)
  const frozen = getFrozenColumns(erpTable)
  const wbModule = writebackModuleForTable(erpTable)
  const pushOnly = wbModule ? pushOnlyColumns(erpTable) : new Set()

  const defs = db.prepare(`
    SELECT m.*, cf.type AS render_type, cf.options AS render_options
    FROM airtable_field_mappings m
    LEFT JOIN custom_fields cf
      ON cf.erp_table = m.erp_table AND cf.column_name = m.column_name AND cf.deleted_at IS NULL
    WHERE m.erp_table=?
  `).all(erpTable)

  // Noms de champs Airtable et colonnes ERP pris en charge par le field_map cœur.
  const coreFieldNames = new Set(Object.values(fieldMap || {}).filter(v => typeof v === 'string'))
  const coreColumns = new Set(Object.keys(fieldMap || {}).filter(k => cols.has(k)))
  const coreKeyByFieldName = new Map()
  for (const [k, v] of Object.entries(fieldMap || {})) {
    if (typeof v === 'string' && !coreKeyByFieldName.has(v)) coreKeyByFieldName.set(v, k)
  }

  // Un champ Airtable peut alimenter plusieurs colonnes Boréal (une def par
  // colonne). Le registre, lui, raisonne par CHAMP Airtable (clé
  // mirror_id+field_name) : on retient la def qui décrit le mieux l'état — une
  // def active plutôt qu'une désactivée ou un placeholder — et on mentionne les
  // colonnes supplémentaires en note.
  const defsByName = new Map()
  for (const d of defs) {
    if (!d.airtable_field_name) continue
    if (!defsByName.has(d.airtable_field_name)) defsByName.set(d.airtable_field_name, [])
    defsByName.get(d.airtable_field_name).push(d)
  }
  const liveFirst = (list) => [...list].sort((a, b) =>
    (a.import_disabled === 1 || a.column_name === '__pending__' ? 1 : 0)
    - (b.import_disabled === 1 || b.column_name === '__pending__' ? 1 : 0))
  const defByName = new Map([...defsByName].map(([name, list]) => [name, liveFirst(list)[0]]))
  const extraColumns = (name, chosen) => defsByName.get(name)
    ?.filter(d => d !== chosen && d.column_name !== '__pending__')
    .map(d => d.column_name) || []

  const atFieldIds = new Set((atTable?.fields || []).map(f => f.id))
  const classified = []

  for (const f of atTable?.fields || []) {
    const role = roleOf(f.type)
    const base = { field: f.name, field_id: f.id, airtable_type: f.type, role }
    const comparableRole = role === 'scalar' || role === 'computed'
    const d = defByName.get(f.name)

    // 1. Aucun mapping. Soit le field_map cœur le prend en charge (codé en dur,
    //    invisible dans l'app), soit la décision n'a jamais été prise.
    if (!d) {
      if (coreFieldNames.has(f.name)) {
        const key = coreKeyByFieldName.get(f.name)
        classified.push({
          ...base, state: 'core', core_key: key,
          erp_column: cols.has(key) ? key : null,
          comparable: false, reason: CORE_UNCOMPARABLE_REASON,
          field_type: 'text', options: {},
          note: cols.has(key) ? null : `clé cœur « ${key} » sans colonne ERP`,
        })
      } else {
        classified.push({ ...base, state: 'unmapped', erp_column: null, comparable: false })
      }
      continue
    }

    // 2. Mapping présent — rejouer les filtres du sync dynamique, dans l'ordre.
    let mappingOptions = {}
    try { mappingOptions = JSON.parse(d.options || '{}') } catch {}
    let renderOptions = {}
    try { renderOptions = JSON.parse(d.render_options || '{}') } catch {}
    const isLink = !!mappingOptions.link_target_table
    const fieldType = isLink ? 'link' : (d.render_type || 'text')
    const row = {
      ...base,
      role: isLink ? 'link' : role,
      erp_column: d.column_name,
      field_type: fieldType,
      link_target: mappingOptions.link_target_table || null,
      options: {
        format: mappingOptions.format,
        ...renderOptions,
        link_target_table: mappingOptions.link_target_table || null,
      },
    }

    if (d.import_disabled === 1) {
      classified.push({ ...row, state: 'excluded', reason: 'import désactivé', comparable: false }); continue
    }
    if (d.column_name === '__pending__') {
      classified.push({ ...row, state: 'excluded', reason: 'placeholder __pending__', comparable: false }); continue
    }
    if (coreFieldNames.has(d.airtable_field_name)) {
      classified.push({ ...row, state: 'core', core_key: coreKeyByFieldName.get(d.airtable_field_name),
        comparable: false, reason: CORE_UNCOMPARABLE_REASON }); continue
    }
    if (coreColumns.has(d.column_name)) {
      classified.push({ ...row, state: 'core', core_key: d.column_name,
        reason: 'colonne prise par le field_map cœur', comparable: false }); continue
    }
    // Champ CALCULÉ de Boréal (formule, lookup, rollup, « créé le »…) : pas de
    // colonne physique — sa valeur vit dans la vue <table>_v et ne part que vers
    // Airtable. Ce n'est donc pas un mapping cassé, c'est un miroir en push.
    if (!cols.has(d.column_name) && pushOnly.has(d.column_name)) {
      classified.push({ ...row, state: 'mirrored', direction: 'push',
        reason: 'champ calculé Boréal — poussé seulement', comparable: false }); continue
    }
    if (!cols.has(d.column_name)) {
      classified.push({ ...row, state: 'broken', reason: 'colonne ERP absente', comparable: false }); continue
    }
    if (dynamicFieldDirection(wbModule, d.column_name) === 'push') {
      classified.push({ ...row, state: 'mirrored', direction: 'push',
        reason: 'sens push — le sync entrant n\'écrit pas', comparable: false }); continue
    }
    if (frozen.has(d.column_name)) {
      classified.push({ ...row, state: 'mirrored', direction: 'push',
        reason: 'colonne gelée', comparable: false }); continue
    }
    // Colonne NOT NULL : l'import écrirait NULL dessus, on l'exclut — sauf pour
    // une colonne lien poussable, que le sync entrant n'écrit qu'en COALESCE (un
    // lien non résolu ne délie jamais le record) et que le write-back sait
    // renvoyer. C'est le cas de shipments.order_id (« Commande lié »).
    if (notNull.has(d.column_name) && !pushableLinkColumn(wbModule, d.column_name)) {
      classified.push({ ...row, state: 'excluded', reason: 'colonne NOT NULL sans défaut', comparable: false }); continue
    }

    const extras = extraColumns(f.name, d)
    classified.push({
      ...row, state: 'mirrored',
      direction: dynamicFieldDirection(wbModule, d.column_name),
      comparable: comparableRole,
      reason: comparableRole ? null : `type ${f.type} — valeur non comparable`,
      note: extras.length ? `alimente aussi ${extras.join(', ')}` : null,
    })
  }

  // 3. Mappings orphelins : pointent vers un champ Airtable qui n'existe plus.
  //    Ce sont les fantômes `webhook_*` — un airtable_field_id synthétique jamais
  //    créé dans Airtable, ou un champ supprimé depuis.
  const atNames = new Set((atTable?.fields || []).map(f => f.name))
  const orphanMappings = defs
    .filter(d => d.column_name !== '__pending__')
    .filter(d => !atNames.has(d.airtable_field_name))
    .map(d => ({
      erp_column: d.column_name,
      field: d.airtable_field_name,
      field_id: d.airtable_field_id,
      synthetic_id: !d.airtable_field_id || !atFieldIds.has(d.airtable_field_id),
      import_disabled: d.import_disabled === 1,
    }))

  return { fields: classified, orphanMappings, coreKeyCount: Object.keys(fieldMap || {}).length }
}

// ── Métadonnées Airtable ────────────────────────────────────────────────────

async function fetchBaseSchema(baseId, token) {
  const data = await airtableFetch(`/meta/bases/${baseId}/tables`, token)
  const byId = new Map()
  for (const t of data.tables || []) byId.set(t.id, t)
  return byId
}

// Pacing : Airtable plafonne à 5 requêtes/seconde et par base. Le rafraîchissement
// du registre partage ce quota avec le sync de production.
const PACE_MS = 220
let lastCall = 0
async function paced(fn) {
  const wait = PACE_MS - (Date.now() - lastCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastCall = Date.now()
  return fn()
}

// Un échantillon suffit à repérer les champs porteurs de pièces jointes image —
// c'est déjà ainsi que le sync procède (`imageFieldNames(writable, records)`).
// Best-effort : un champ vide sur les 100 premiers records ne sera pas détecté
// ici, l'auditeur garde donc son propre filet au moment de comparer.
async function sampleImageFields(baseId, tableId, token) {
  try {
    const data = await paced(() => airtableFetch(`/${baseId}/${tableId}?pageSize=100`, token))
    const names = new Set()
    for (const rec of data.records || []) {
      for (const [name, val] of Object.entries(rec.fields || {})) {
        if (!names.has(name) && hasImageAttachments(val)) names.add(name)
      }
    }
    return names
  } catch {
    return new Set()
  }
}

// ── Remplissage ─────────────────────────────────────────────────────────────

const nowExpr = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

/**
 * Rafraîchit le registre depuis les métadonnées Airtable et la configuration
 * historique. Idempotent, non destructif : une ligne dont `decided_by='user'`
 * garde sa décision, seul le côté Airtable (nom, type, id de champ) est mis à
 * jour dessus.
 *
 * Retourne un résumé chiffré — c'est lui qui rend le contrat mesurable.
 */
export async function syncMirrorRegistry({ token, includeUndecidedTables = true } = {}) {
  const accessToken = token || await getAccessToken()

  // Config historique de chaque miroir de la graine.
  const seeded = []
  const baseIds = new Set()
  for (const m of MIRROR_SEED) {
    const cfg = resolveLegacyConfig(m)
    if (!cfg?.baseId || !cfg?.tableId) continue
    seeded.push({ ...m, cfg2: cfg })
    baseIds.add(cfg.baseId)
  }

  // Schéma de chaque base concernée, une fois.
  const schemas = new Map()
  for (const baseId of baseIds) {
    schemas.set(baseId, await paced(() => fetchBaseSchema(baseId, accessToken)))
  }

  const summary = {
    refreshed_at: new Date().toISOString(),
    bases: baseIds.size,
    mirrors: { mirrored: 0, paused: 0, excluded: 0, undecided: 0 },
    fields: { mirrored: 0, core: 0, excluded: 0, unmapped: 0, broken: 0 },
    orphan_mappings: 0,
    core_keys: 0,
    preserved_user_decisions: 0,
  }

  const upsertMirror = db.prepare(`
    INSERT INTO airtable_mirrors
      (id, base_id, table_id, airtable_name, erp_table, status, depends_on, purge_orphans, decided_by, decided_at, last_synced_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'backfill',${nowExpr},?,${nowExpr},${nowExpr})
    ON CONFLICT(id) DO UPDATE SET
      base_id       = excluded.base_id,
      table_id      = excluded.table_id,
      airtable_name = excluded.airtable_name,
      -- Le côté décision n'est réécrit que si personne ne l'a tranché à la main.
      erp_table  = CASE WHEN airtable_mirrors.decided_by='user' THEN airtable_mirrors.erp_table  ELSE excluded.erp_table  END,
      status     = CASE WHEN airtable_mirrors.decided_by='user' THEN airtable_mirrors.status     ELSE excluded.status     END,
      depends_on = CASE WHEN airtable_mirrors.decided_by='user' THEN airtable_mirrors.depends_on ELSE excluded.depends_on END,
      purge_orphans = CASE WHEN airtable_mirrors.decided_by='user' THEN airtable_mirrors.purge_orphans ELSE excluded.purge_orphans END,
      last_synced_at = excluded.last_synced_at,
      updated_at = ${nowExpr}
  `)

  const upsertField = db.prepare(`
    INSERT INTO airtable_field_map
      (id, mirror_id, field_id, field_name, airtable_type, erp_column, role, link_target,
       direction, state, exclude_reason, core_key, decided_by, decided_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'backfill',${nowExpr},${nowExpr},${nowExpr})
    ON CONFLICT(mirror_id, field_name) DO UPDATE SET
      field_id      = excluded.field_id,
      airtable_type = excluded.airtable_type,
      erp_column     = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.erp_column     ELSE excluded.erp_column     END,
      role           = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.role           ELSE excluded.role           END,
      link_target    = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.link_target    ELSE excluded.link_target    END,
      direction      = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.direction      ELSE excluded.direction      END,
      state          = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.state          ELSE excluded.state          END,
      exclude_reason = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.exclude_reason ELSE excluded.exclude_reason END,
      core_key       = CASE WHEN airtable_field_map.decided_by='user' THEN airtable_field_map.core_key       ELSE excluded.core_key       END,
      updated_at = ${nowExpr}
  `)

  const userDecided = db.prepare(
    'SELECT COUNT(*) AS n FROM airtable_field_map WHERE decided_by=?'
  ).get('user').n
  summary.preserved_user_decisions = userDecided

  // 1. Miroirs configurés + leurs champs.
  const seenTableIds = new Set()
  for (const m of seeded) {
    const { baseId, tableId, fieldMapRaw, lastSyncedAt } = m.cfg2
    const atTable = schemas.get(baseId)?.get(tableId)
    seenTableIds.add(`${baseId}::${tableId}`)

    const status = STATUS_BY_SYNC[m.sync] || 'mirrored'
    upsertMirror.run(
      m.id, baseId, tableId, atTable?.name || null, m.erpTable, status,
      JSON.stringify(m.dependsOn || []), m.purgeOrphans === false ? 0 : 1, lastSyncedAt || null
    )
    summary.mirrors[status]++

    // Une table configurée dont le table_id n'existe plus dans la base : rien à
    // classer, mais le miroir reste inscrit avec son écart visible.
    if (!atTable) continue

    const fieldMap = parseFieldMap(fieldMapRaw)
    const { fields, orphanMappings, coreKeyCount } = classifyFields(m, atTable, fieldMap)
    summary.orphan_mappings += orphanMappings.length
    summary.core_keys += coreKeyCount

    const imageFields = await sampleImageFields(baseId, tableId, accessToken)

    db.transaction(() => {
      for (const f of fields) {
        // Un champ image reste `mirrored` (le sync l'alimente bien) mais son rôle
        // dit pourquoi sa valeur n'est pas comparable.
        const role = imageFields.has(f.field) ? 'attachment' : f.role
        upsertField.run(
          newRecordId(), m.id, f.field_id || null, f.field, f.airtable_type || null,
          f.erp_column || null, role, f.link_target || null,
          f.direction || (f.state === 'mirrored' ? 'pull' : 'none'),
          f.state, f.reason || null, f.core_key || null
        )
        summary.fields[f.state]++
      }
    })()
  }

  // 2. Toutes les autres tables Airtable, inscrites comme non tranchées. C'est
  //    ce qui interdit le troisième état « on n'y a jamais pensé » : les 32
  //    tables sans miroir deviennent une liste de décisions à prendre, visible
  //    et comptée, au lieu d'un angle mort.
  if (includeUndecidedTables) {
    for (const [baseId, byId] of schemas) {
      for (const [tableId, atTable] of byId) {
        if (seenTableIds.has(`${baseId}::${tableId}`)) continue
        const existing = db.prepare(
          'SELECT id, decided_by FROM airtable_mirrors WHERE base_id=? AND table_id=?'
        ).get(baseId, tableId)
        if (existing?.decided_by === 'user') { summary.mirrors.excluded++; continue }
        const id = existing?.id || `undecided:${tableId}`
        upsertMirror.run(id, baseId, tableId, atTable.name, null, 'undecided', '[]', null)
        summary.mirrors.undecided++
      }
    }
  }

  return summary
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export function registryIsEmpty() {
  if (!tableExists('airtable_mirrors')) return true
  return db.prepare('SELECT COUNT(*) AS n FROM airtable_mirrors').get().n === 0
}

/**
 * Miroirs à synchroniser/auditer, dans l'ordre de leurs dépendances.
 * `depends_on` remplace la constante MODULE_SYNC_PRIORITY : l'ordre se déduit
 * des données, donc ajouter un miroir ne demande plus de toucher au code.
 */
export function readMirrors({ statuses = ['mirrored', 'paused'] } = {}) {
  const placeholders = statuses.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT * FROM airtable_mirrors
    WHERE status IN (${placeholders})
    ORDER BY id
  `).all(...statuses)

  // Tri topologique tolérant : une dépendance absente ou circulaire ne doit pas
  // faire disparaître un miroir de la liste, seulement le laisser à sa place.
  const byId = new Map(rows.map(r => [r.id, r]))
  const ordered = []
  const state = new Map() // id → 'visiting' | 'done'
  const visit = (row) => {
    if (state.get(row.id) === 'done') return
    if (state.get(row.id) === 'visiting') return // cycle : on s'arrête là
    state.set(row.id, 'visiting')
    let deps = []
    try { deps = JSON.parse(row.depends_on || '[]') } catch {}
    for (const depId of deps) {
      const dep = byId.get(depId)
      if (dep) visit(dep)
    }
    state.set(row.id, 'done')
    ordered.push(row)
  }
  for (const row of rows) visit(row)
  return ordered
}

export function readFieldMap(mirrorId) {
  return db.prepare(
    'SELECT * FROM airtable_field_map WHERE mirror_id=? ORDER BY field_name'
  ).all(mirrorId)
}

/** Compteurs du contrat — ceux qui doivent tomber à zéro. */
export function registryCounters() {
  const mirrors = db.prepare(
    'SELECT status, COUNT(*) AS n FROM airtable_mirrors GROUP BY status'
  ).all().reduce((a, r) => { a[r.status] = r.n; return a }, {})
  const fields = db.prepare(
    'SELECT state, COUNT(*) AS n FROM airtable_field_map GROUP BY state'
  ).all().reduce((a, r) => { a[r.state] = r.n; return a }, {})
  return { mirrors, fields }
}
