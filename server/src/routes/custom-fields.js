import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { regenerateView, validateFormulaExpr, validateFormulaReferences, validateLookup, validateRollup, validateLink, setLinkValue, readLinkValue, getLinkOptions, deleteLinkGroup, LINK_TARGET_WHITELIST, getLookupMeta, recordLinkTargetOf, previewFormula, getFieldDependents, ACTIVITY_ENTITY_MAP } from '../services/customFieldsView.js'
import { parseDurationToSeconds, normalizeDurationFormat } from '../services/duration.js'
import { runRuleActionForRecord } from '../services/fieldRuleEngine.js'
import { findLabelConflict, labelConflictError } from '../utils/fieldLabels.js'
import { isColumnWritable } from '../services/customFieldWritability.js'
import { invalidateColumnsCache } from '../db/changeLog.js'
import { erpTableForAirtableTableId } from '../services/airtableTableMap.js'
import { writebackModuleForTable, PUSH_ONLY_CF_KINDS } from '../services/airtableWriteback.js'
import { purgedNativeFields, clearFieldTombstone } from '../services/fieldPurge.js'
import { planTypeConversion, applyTypeConversion, convertSingleValue } from '../services/fieldTypeConvert.js'
import { LINKABLE_TABLES } from '../services/recordLinks.js'

const router = Router()
router.use(requireAuth)

// Tables sur lesquelles on autorise les champs custom.
//
// CLAUDE.md exige que l'utilisateur puisse créer des champs personnalisés
// « dans chaque table ». On expose donc toutes les tables d'entités principales
// (et plus seulement projects/factures). Chaque entrée doit être une VRAIE table
// (pas une vue dérivée) possédant une colonne `id` — la création d'un champ
// kind='data' fait un `ALTER TABLE … ADD COLUMN`, et les champs virtuels
// (formula/lookup/rollup/auto) régénèrent la vue `<table>_v`.
//
// Note : la lecture du cache client (bootstrap.js) lit la table physique via
// PRAGMA, donc les colonnes cf_* remontent au front de façon identique pour
// toutes ces tables. L'édition inline d'un champ kind='data' reste pilotée par
// la route dédiée de chaque table (whitelist via getWritableCustomColumns) — déjà
// branchée pour projects ; à brancher au besoin sur les autres routes.
const ALLOWED_TABLES = new Set([
  'projects', 'factures',
  'companies', 'contacts', 'products', 'orders', 'tickets', 'tasks',
  'shipments', 'employees', 'purchases', 'achats_fournisseurs',
  'returns', 'sale_receipts', 'serial_numbers', 'interactions',
  // Fusion avec l'ancien système airtable_field_defs (voir migration schema.js) —
  // tables qui n'avaient jusqu'ici que des champs Airtable, jamais de champ custom.
  // ATTENTION : ce sont des VRAIES tables SQL, pas des clés de vue DataTable.
  // Les vues 'retours' → returns et 'abonnements' → subscriptions passent par
  // l'alias client (sqlTableForView, customFieldDisplay.jsx). 'company_serials'
  // est une jointure embarquée (fiche entreprise) sans table propre — pas de
  // champ custom possible.
  'order_items', 'subscriptions', 'return_items', 'adresses',
  'soumissions', 'assemblages', 'paies', 'paie_items', 'bom_items',
  // Paiements clients (encaissements + remboursements) — page « Paiements ».
  'payments',
  // Mouvements de numéros de série — champs créés depuis /airtable/fields/serial_changes.
  'serial_state_changes',
])

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field'
}

function ensureUniqueColumnName(erpTable, base) {
  const existing = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  // Préfixe `cf_` pour bien isoler des colonnes natives / Airtable.
  let name = `cf_${base}`
  if (!existing.has(name)) return name
  for (let i = 2; i < 100; i++) {
    const candidate = `cf_${base}_${i}`
    if (!existing.has(candidate)) return candidate
  }
  throw new Error('Impossible de générer un nom de colonne unique')
}

// Variante pour les champs virtuels (formula/lookup) : pas de colonne physique
// à créer, mais doit éviter collision avec les colonnes de la table source ET
// avec les autres champs custom actifs (qui partagent le même namespace dans
// la vue).
function ensureUniqueVirtualColumnName(erpTable, base) {
  const physical = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  const virtual = new Set(
    db.prepare(`SELECT column_name FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`)
      .all(erpTable).map(r => r.column_name)
  )
  const taken = new Set([...physical, ...virtual])
  const candidate0 = `cf_${base}`
  if (!taken.has(candidate0)) return candidate0
  for (let i = 2; i < 100; i++) {
    const c = `cf_${base}_${i}`
    if (!taken.has(c)) return c
  }
  throw new Error('Impossible de générer un nom de colonne unique')
}

// Couleurs autorisées pour les choix d'un single_select (alignées sur la
// palette de Badge.jsx côté client). Toute couleur hors liste retombe sur 'gray'.
const SELECT_COLORS = new Set(['gray', 'slate', 'blue', 'indigo', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'teal'])

// Normalise/valide la config d'un single_select OU multi_select.
//   raw          : { choices:[{id?,label,color?}], default_id, default_ids, alphabetize }
//   existingIds  : Set des ids de choix déjà connus (édition) — on les préserve
//                  pour ne pas casser le lien id→label lors d'un renommage.
// `default_id` (singulier) pilote le défaut d'un single_select ; `default_ids`
// (tableau) pilote celui d'un multi_select. Les deux sont normalisés et présents
// dans l'objet retourné (l'un sera simplement vide selon le type).
// Retourne { obj, json } ou lève une Error (message clair pour la route).
function normalizeSelectOptions(raw, _existingIds = new Set()) {
  if (!raw || typeof raw !== 'object') throw new Error('Options requises pour un champ Sélection')
  const inChoices = Array.isArray(raw.choices) ? raw.choices : []
  if (inChoices.length === 0) throw new Error('Au moins un choix est requis')
  const seen = new Set()
  const seenIds = new Set()
  const choices = []
  for (const c of inChoices) {
    const label = String(c?.label ?? '').trim()
    if (!label) throw new Error('Chaque choix doit avoir un libellé')
    const key = label.toLowerCase()
    if (seen.has(key)) throw new Error(`Choix en double : « ${label} »`)
    seen.add(key)
    const color = SELECT_COLORS.has(c?.color) ? c.color : 'gray'
    // On préserve l'id fourni (existant lors d'un renommage, OU généré côté client
    // pour un nouveau choix) tant qu'il est un slug sûr et unique dans le payload —
    // ainsi le default_id/default_ids qui le référence reste valide dès la création.
    // Sinon (absent / invalide / collision), on en génère un.
    let id = c?.id
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_]{1,40}$/.test(id) || seenIds.has(id)) {
      id = `opt_${uuid().slice(0, 8)}`
    }
    seenIds.add(id)
    choices.push({ id, label, color })
  }
  if (raw.alphabetize) {
    choices.sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }))
  }
  let defaultId = raw.default_id || null
  if (defaultId && !choices.some(c => c.id === defaultId)) defaultId = null
  // Multi-select : tableau d'ids de choix par défaut. On filtre les ids orphelins
  // et on déduplique en préservant l'ordre.
  let defaultIds = []
  if (Array.isArray(raw.default_ids)) {
    const seenId = new Set()
    for (const id of raw.default_ids) {
      if (choices.some(c => c.id === id) && !seenId.has(id)) { seenId.add(id); defaultIds.push(id) }
    }
  }
  const obj = { choices, default_id: defaultId, default_ids: defaultIds, alphabetize: !!raw.alphabetize }
  return { obj, json: JSON.stringify(obj) }
}

// Applique les valeurs par défaut des champs custom kind='data' à un
// enregistrement fraîchement créé (les colonnes cf_* ne sont pas dans l'INSERT
// natif). Best effort : n'écrit que les colonnes ayant un défaut configuré et
// laissées vides. Couvre :
//   - single_select : label du choix marqué default_id dans `options`
//   - text/number/currency/url : `default_value` (la colonne REAL coerce le
//     texte numérique pour number/currency)
// Exporté pour les routes de création (ex: projects POST).
export function applyCustomFieldDefaults(erpTable, recordId) {
  const fields = db.prepare(
    `SELECT column_name, type, default_value, options FROM custom_fields
     WHERE erp_table=? AND deleted_at IS NULL AND kind='data'`
  ).all(erpTable)
  for (const f of fields) {
    let value = null
    if (f.type === 'single_select') {
      if (!f.options) continue
      let opts
      try { opts = JSON.parse(f.options) } catch { continue }
      const def = opts?.choices?.find(c => c.id === opts.default_id)
      if (!def) continue
      value = def.label
    } else if (f.type === 'multi_select') {
      // multi_select : colonne TEXT stockant un tableau JSON de labels. Le défaut
      // est la liste des labels des choix marqués default_ids.
      if (!f.options) continue
      let opts
      try { opts = JSON.parse(f.options) } catch { continue }
      const ids = Array.isArray(opts?.default_ids) ? opts.default_ids : []
      if (!ids.length) continue
      const labels = ids
        .map(id => opts.choices?.find(c => c.id === id)?.label)
        .filter(l => l != null && l !== '')
      if (!labels.length) continue
      value = JSON.stringify(labels)
    } else {
      // text / number / currency / url
      if (f.default_value === null || f.default_value === undefined || f.default_value === '') continue
      value = f.default_value
    }
    db.prepare(`UPDATE ${erpTable} SET ${f.column_name}=? WHERE id=? AND (${f.column_name} IS NULL OR ${f.column_name}='')`)
      .run(value, recordId)
  }
}

// Alias rétro-compatible : l'ancien nom ne couvrait que les single_select, le
// nouveau couvre aussi les défauts text/number/currency/url.
export const applySingleSelectDefaults = applyCustomFieldDefaults

// Styles autorisés pour un champ Bouton (couleurs alignées sur le rendu client).
const BUTTON_STYLES = new Set(['brand', 'green', 'red', 'slate'])

// Normalise/valide la config d'un champ 'button'. La config tient dans la colonne
// `options` (JSON) : { label, automation_id, style }. Le bouton déclenche une
// automation kind='field_rule' sur le record de la ligne au clic. On vérifie que
// l'automation référencée existe et est bien une règle de champ. Retourne
// { obj, json } ou lève une Error (message clair pour la route).
function normalizeButtonOptions(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Configuration du bouton requise')
  const label = String(raw.label ?? '').trim()
  if (!label) throw new Error('Libellé du bouton requis')
  const automationId = String(raw.automation_id ?? '').trim()
  if (!automationId) throw new Error('Automation à déclencher requise')
  const a = db.prepare(`SELECT id, kind FROM automations WHERE id=? AND deleted_at IS NULL`).get(automationId)
  if (!a) throw new Error('Automation introuvable')
  if (a.kind !== 'field_rule') throw new Error('Le bouton ne peut déclencher qu\'une règle de champ')
  const style = BUTTON_STYLES.has(raw.style) ? raw.style : 'brand'
  const obj = { label, automation_id: automationId, style }
  return { obj, json: JSON.stringify(obj) }
}

// Normalise/valide la config d'un champ 'duration'. La config tient dans la
// colonne `options` (JSON) : { format: 'h:mm' | 'h:mm:ss' }. Retourne { json }.
function normalizeDurationOptions(raw) {
  const format = normalizeDurationFormat(raw?.format)
  return { json: JSON.stringify({ format }) }
}

// Normalise/valide la config d'un champ 'currency'. La config tient dans la
// colonne `options` (JSON) : { currency: code ISO 4217 à 3 lettres }. Défaut
// CAD (rétro-compatible : les champs devise existants n'ont pas d'options).
// Retourne { json } ou lève une Error (message clair pour la route).
function normalizeCurrencyOptions(raw) {
  const code = String(raw?.currency ?? 'CAD').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('Devise doit être un code ISO 4217 à 3 lettres (ex: CAD, USD, EUR)')
  return { json: JSON.stringify({ currency: code }) }
}

// Normalise/valide la config d'un champ 'phone'. La config tient dans la colonne
// `options` (JSON) : { country_code: 'show' | 'hide' } — affichage ou non de
// l'indicatif de pays (+1) sur les numéros nord-américains. Défaut 'hide'
// (rétro-compatible : les champs téléphone existants n'ont pas d'options et
// s'affichent sans indicatif, comme les champs téléphone natifs). Retourne { json }.
function normalizePhoneOptions(raw) {
  const cc = raw?.country_code === 'show' ? 'show' : 'hide'
  return { json: JSON.stringify({ country_code: cc }) }
}

// Formats de date proposés à l'affichage — miroir de DATE_DISPLAY_FORMATS
// (client/src/lib/formatDate.js). Tenir les deux listes alignées.
const DATE_FORMATS = new Set(['iso_date', 'iso_24h', 'iso_12h', 'local_date', 'local_datetime'])

// Normalise/valide la config d'un champ 'date' (data, ou formula/lookup/rollup
// en result_type='date'). La config tient dans la colonne `options` (JSON) :
// { format: 'iso_date' | 'iso_24h' | 'iso_12h' | 'local_date' | 'local_datetime' }.
// Défaut 'iso_date' (comportement historique, rétro-compatible avec les champs
// créés avant ce réglage). Retourne { json }.
function normalizeDateOptions(raw) {
  const format = DATE_FORMATS.has(raw?.format) ? raw.format : 'iso_date'
  return { json: JSON.stringify({ format }) }
}

// Normalise/valide une valeur par défaut pour un champ kind='data'.
//   raw  : valeur brute du body (string/number/null/undefined)
//   type : 'text' | 'number' | 'currency' | 'url' | 'duration' | 'checkbox'
// Retourne la valeur à stocker (string), ou null si vide/absente.
// Lève une Error (message clair) si number/currency reçoit un non-nombre, ou si
// une durée n'est pas parseable. La durée est stockée en SECONDES (entier).
// Checkbox : '1' si la valeur est vraie (coché par défaut), sinon null (décoché).
function normalizeDefaultValue(raw, type) {
  if (type === 'checkbox') {
    const truthy = raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'vrai'
    return truthy ? '1' : null
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  if (type === 'number' || type === 'currency') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error('Valeur par défaut doit être un nombre')
    return String(n)
  }
  if (type === 'duration') {
    const sec = parseDurationToSeconds(raw)
    if (sec == null) throw new Error('Valeur par défaut doit être une durée valide (ex: 1:30 ou 1:30:00)')
    return String(sec)
  }
  return String(raw)
}

// GET /api/custom-fields/_meta/:erpTable — méta pour l'UI de création :
// colonnes FK + tables/colonnes autorisées en lookup. Utilisé par les
// dropdowns de la modale de création.
router.get('/_meta/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  try { res.json(getLookupMeta(erpTable)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// GET /api/custom-fields/:id/dependents — rapport d'usage : tout ce que la
// suppression de ce champ va affecter (autres champs calculés — même table et
// cross-table —, champ inverse d'une liaison, automations, vues, règles de
// visibilité). Consommé par la modale au moment de la suppression pour avertir
// AVANT de casser, plutôt que de le découvrir à l'#ERROR silencieux.
router.get('/:id/dependents', (req, res) => {
  const field = db.prepare(
    `SELECT id, erp_table, name, column_name, kind, link_group_id FROM custom_fields WHERE id=? AND deleted_at IS NULL`
  ).get(req.params.id)
  if (!field) return res.status(404).json({ error: 'Champ introuvable' })
  try {
    const dependents = getFieldDependents(field)
    res.json({ field: { id: field.id, name: field.name, column_name: field.column_name }, dependents })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/custom-fields/:erpTable — liste les champs custom actifs pour une table.
// Les lignes kind='native' (personnalisation d'un champ défini dans tableDefs.js)
// sont EXCLUES : elles ne décrivent pas un champ à ajouter aux colonnes de la
// page, mais une retouche d'un champ qui s'y trouve déjà. Elles se lisent par
// GET /:erpTable/native.
router.get('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée pour les champs custom' })
  const rows = db.prepare(
    `SELECT cf.id, cf.name, cf.column_name, cf.type, cf.decimals, cf.sort_order,
            cf.kind, cf.formula_expr, cf.lookup_fk, cf.lookup_target_table, cf.lookup_target_column, cf.result_type,
            cf.rollup_target_table, cf.rollup_target_fk, cf.rollup_target_column, cf.rollup_agg, cf.view_error, cf.options, cf.default_value,
            cf.link_target_table, cf.link_group_id, cf.link_role, cf.link_single, cf.source, cf.airtable_mapping_id,
            cf.description,
            m.id AS mapping_id, m.import_disabled, m.options AS mapping_options
     FROM custom_fields cf
     LEFT JOIN airtable_field_mappings m
       ON m.erp_table = cf.erp_table AND m.column_name = cf.column_name
     WHERE cf.erp_table=? AND cf.deleted_at IS NULL AND cf.kind <> 'native'
     ORDER BY cf.sort_order, cf.created_at`
  ).all(erpTable)
  // `writable` : règle d'éditabilité unique (services/customFieldWritability.js)
  // — un champ Airtable en 'pull' avec import actif est en lecture seule côté
  // ERP (toute écriture serait écrasée au prochain sync). Le client s'en sert
  // pour désactiver l'édition inline (customFieldToColumn).
  const wbModule = writebackModuleForTable(erpTable)
  const data = rows.map(({ mapping_id, import_disabled, mapping_options, ...row }) => {
    // `record_link` / `record_link_target` : la valeur de ce champ est-elle un
    // identifiant d'enregistrement, et vers quelle table ? Le client s'en sert
    // pour l'afficher en lien cliquable (cf. LinkedRecordsValue).
    //
    //  - champ lien Airtable : la table cible vit sur le mapping
    //    (`link_target_table`) ; absente = la colonne garde les record IDs
    //    Airtable bruts, que recordLinks.js retrouve par miroir sans indice.
    //  - LOOKUP qui rapatrie un champ lien ou une colonne FK : la valeur copiée
    //    reste un identifiant, donc elle reste navigable — c'est la table du
    //    champ SOURCE qui compte, pas celle traversée par le lookup.
    //
    // À ne pas confondre avec `link_target_table` (colonne custom_fields : vraie
    // relation ERP avec champ inverse, cf. schema.js).
    let recordLink = false
    let target = null
    // Identité stockée dans la colonne : id Boréal quand le mapping a une table
    // cible (la sync traduit à l'import), record ID Airtable sinon. L'éditeur de
    // lien doit écrire la MÊME identité que les valeurs déjà là — sans quoi une
    // colonne finirait avec les deux, et les jointures sur airtable_id
    // tomberaient (cf. journal-entries.js, fin de mois).
    let identity = null
    let mopts = null
    if (mapping_options) {
      try { mopts = JSON.parse(mapping_options) } catch { mopts = null }
      target = mopts?.link_target_table || null
    }
    let cfOpts = null
    try { cfOpts = JSON.parse(row.options || 'null') } catch { cfOpts = null }
    if (cfOpts?.airtable_link_hint) {
      recordLink = true
      identity = target ? 'erp' : 'airtable'
      // Mapping sans table cible : la table visée reste connue — c'est celle que
      // miroite `linked_table_id`. On la publie pour l'affichage et pour
      // proposer des candidats à l'association, sans toucher au mapping (le
      // renseigner réécrirait les valeurs stockées).
      if (!target) target = erpTableForAirtableTableId(mopts?.linked_table_id)
    }
    else if (row.kind === 'lookup' && row.lookup_target_table && row.lookup_target_column) {
      const hit = recordLinkTargetOf(row.lookup_target_table, row.lookup_target_column)
      if (hit) { recordLink = true; target = hit.table }
    }
    // Champ `data` dont la COLONNE est une clé étrangère (ex. « Contact » des
    // retours, ex-natif contact_id adopté par la migration 027) : la valeur est
    // un id ERP, donc navigable. Sans ça un champ adossé à une FK s'affiche en
    // identifiant brut, alors que la règle « champs référence » du CLAUDE.md
    // veut un lien cliquable vers la fiche visée.
    else if (row.kind === 'data') {
      const hit = recordLinkTargetOf(erpTable, row.column_name)
      if (hit) { recordLink = true; target = hit.table; identity = 'erp' }
    }
    // Décimales d'un nombre importé d'Airtable : tant que l'utilisateur n'en a
    // pas fixé (colonne NULL), on publie la précision déclarée côté Airtable
    // (options.precision du mapping, posée par la sync). Le client (tableau et
    // modal de champ) voit ainsi la MÊME valeur effective — avant, le modal
    // affichait « 2 » par défaut alors que la cellule rendait la valeur brute.
    let decimals = row.decimals
    if (decimals == null && row.type === 'number' && Number.isInteger(mopts?.precision)) {
      decimals = Math.max(0, Math.min(5, mopts.precision))
    }
    return {
      ...row,
      decimals,
      record_link: recordLink,
      record_link_target: target,
      record_link_identity: identity,
      writable: isColumnWritable(erpTable, { ...row, mapping_id, import_disabled }, wbModule),
    }
  })
  res.json({ data })
})

// ── Champs NATIFS (kind='native') ────────────────────────────────────────────
//
// Personnalisation des colonnes définies en dur dans client/src/lib/tableDefs.js :
// renommage, type d'affichage, décimales, indicatif téléphonique, ordre. Purement
// cosmétique — aucune colonne SQL n'est touchée, les syncs continuent d'écrire
// dans les colonnes d'origine.
//
// Ces routes remplacent /api/field-overrides (table field_overrides), supprimé :
// un seul stockage, une seule route, un seul vocabulaire de types. La forme des
// réponses est conservée (`field_id`) pour rester le contrat attendu par le
// client. Voir la migration dans db/schema.js pour les conventions (name/type
// vides = « pas de personnalisation »).
//
// `erp_table` est une clé de vue DataTable (ex. 'company_orders'), pas forcément
// une table SQL : on valide le format, pas l'appartenance à ALLOWED_TABLES.
const NATIVE_TABLE_RE = /^[a-z0-9_]{1,64}$/
const NATIVE_FIELD_RE = /^[a-zA-Z0-9_]{1,80}$/
// Types d'affichage supportés par applyFieldOverrides côté client. 'boolean'
// reste accepté en entrée (ancien vocabulaire) mais est stocké 'checkbox'.
const NATIVE_TYPES = new Set(['text', 'number', 'currency', 'date', 'checkbox', 'url', 'phone'])
// …plus la famille « lien vers une autre table » : `link:<table ERP>`. La cible
// est portée par le type lui-même — un champ natif n'a pas d'autre endroit où
// la ranger, et ça garde le réglage réversible d'un simple changement de type.
// Ne sont acceptées que les tables qui ont une fiche à ouvrir.
const NATIVE_LINK_RE = /^link:([a-z0-9_]{1,64})$/
export function isNativeType(t) {
  if (NATIVE_TYPES.has(t)) return true
  const m = NATIVE_LINK_RE.exec(String(t || ''))
  return !!m && LINKABLE_TABLES.includes(m[1])
}

// Config des CHOIX d'un champ natif de type Sélection (tableDefs.js déclare la
// liste des valeurs possibles ; l'utilisateur la personnalise ici).
//
// Différence essentielle avec un champ perso : la VALEUR stockée en base ne
// bouge jamais — les syncs (Airtable, Stripe…) et le code serveur continuent
// d'écrire et de comparer « En attente ». Un choix natif porte donc deux
// choses distinctes :
//   value : la valeur réellement stockée dans la colonne (figée)
//   label : ce que l'utilisateur veut voir à l'écran (renommage cosmétique)
// plus une couleur d'affichage optionnelle (`null` = couleur d'origine, celle
// que la page rendait déjà). L'ORDRE du tableau est l'ordre d'affichage.
// Retirer un choix le sort des sélecteurs ; les lignes qui portent encore la
// valeur continuent de l'afficher telle quelle.
function normalizeNativeSelectOptions(raw) {
  if (raw == null || raw === '') return null // « pas de config » (réinitialisation)
  let obj = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { throw new Error('Choix invalides (JSON attendu)') }
  }
  if (!obj || typeof obj !== 'object') throw new Error('Choix invalides')
  const inChoices = Array.isArray(obj.choices) ? obj.choices : []
  if (inChoices.length > 300) throw new Error('Trop de choix (300 maximum)')
  const seen = new Set()
  const choices = []
  for (const c of inChoices) {
    // Un choix neuf n'a pas encore de valeur : c'est son libellé qui la fixe,
    // une fois pour toutes.
    const label = String(c?.label ?? '').trim()
    const value = String(c?.value ?? label).trim()
    if (!value) continue // choix vide (ligne en cours de saisie) — ignoré
    if (value.length > 200 || label.length > 200) throw new Error('Choix trop long (200 caractères maximum)')
    if (seen.has(value)) throw new Error(`Choix en double : « ${value} »`)
    seen.add(value)
    choices.push({ value, label: label || value, color: SELECT_COLORS.has(c?.color) ? c.color : null })
  }
  if (choices.length === 0) return null
  return { choices }
}

// Fusionne la config de choix avec ce qui est déjà enregistré : `options` porte
// parfois d'autres drapeaux sur un champ natif (ex. airtable_link_hint), qu'un
// enregistrement des choix n'a aucune raison d'effacer.
function mergeNativeOptions(existingJson, nextChoicesObj) {
  let base = null
  if (existingJson) { try { base = JSON.parse(existingJson) } catch { base = null } }
  const rest = (base && typeof base === 'object') ? { ...base } : {}
  delete rest.choices
  if (!nextChoicesObj) return Object.keys(rest).length ? JSON.stringify(rest) : null
  return JSON.stringify({ ...rest, ...nextChoicesObj })
}

// Description libre d'un champ (infobulle « ? » de l'en-tête de colonne).
// `null` / vide = pas de description. Texte brut, 500 caractères maximum.
const DESCRIPTION_MAX = 500
function normalizeDescription(raw) {
  if (raw == null) return null
  if (typeof raw !== 'string') throw new Error('Description invalide')
  const d = raw.trim()
  if (d.length > DESCRIPTION_MAX) throw new Error(`Description trop longue (${DESCRIPTION_MAX} caractères maximum)`)
  return d || null
}

function nativeParams(req, res) {
  const { erpTable, fieldId } = req.params
  if (!NATIVE_TABLE_RE.test(erpTable)) { res.status(400).json({ error: 'Table invalide' }); return null }
  if (fieldId !== undefined && !NATIVE_FIELD_RE.test(fieldId)) { res.status(400).json({ error: 'Champ invalide' }); return null }
  return { erpTable, fieldId }
}

// Ligne native → forme attendue par le client. Les sentinelles vides
// redeviennent des `null` : « rien de personnalisé sur cet aspect ».
function nativeRow(r) {
  return {
    field_id: r.column_name,
    label: r.name || null,
    type: r.type || null,
    decimals: r.decimals,
    country_code: r.country_code,
    // Choix personnalisés d'un natif de type Sélection (JSON string, comme pour
    // les champs perso) — null quand rien n'est personnalisé.
    options: r.options || null,
    description: r.description || null,
    sort_order: r.sort_order,
    hidden: r.hidden === 1,
  }
}

router.get('/:erpTable/native', (req, res) => {
  const p = nativeParams(req, res)
  if (!p) return
  // Trois familles de lignes :
  //   1. kind='native' vivantes — personnalisations classiques (label/type).
  //   2. lignes soft-SUPPRIMÉES dont la colonne n'est pas préfixée cf_ — champs
  //      natifs, ADOPTÉS ou CONVERTIS depuis une colonne native. Sans elles,
  //      supprimer un tel champ ressusciterait sa définition codée en dur
  //      (tableDefs.js) : la ligne revient ici avec hidden=true, ce qui retire la
  //      définition de partout côté client. La corbeille (deleted_at=NULL) la
  //      restaure complète.
  const rows = db.prepare(
    `SELECT column_name, name, type, decimals, country_code, options, description, sort_order, hidden, deleted_at
     FROM custom_fields
     WHERE erp_table=? AND (
       (deleted_at IS NULL AND kind='native')
       OR (deleted_at IS NOT NULL AND column_name NOT LIKE 'cf\\_%' ESCAPE '\\')
     )`
  ).all(p.erpTable)
  const data = rows.map(r => nativeRow(r.deleted_at ? { ...r, hidden: 1 } : r))
  //   3. champs PURGÉS — vidés de la corbeille, donc sans ligne custom_fields.
  //      Leur pierre tombale vit dans `purged_fields` et survit à la purge :
  //      sans elle, vider la corbeille ferait revenir le champ (sa définition
  //      est codée dans tableDefs.js). Une purge est définitive, la corbeille
  //      n'a plus rien à restaurer.
  const known = new Set(data.map(r => r.field_id))
  for (const t of purgedNativeFields(p.erpTable)) {
    if (known.has(t.column_name)) continue
    data.push(nativeRow({ column_name: t.column_name, name: t.label, hidden: 1, sort_order: null }))
  }
  res.json({ data })
})

// Upsert d'une personnalisation. Body : { label?, type?, decimals?, country_code?, options?, description? }
// — au moins l'un de ces aspects requis (l'ordre passe par PATCH .../native/order).
//
// Chaque aspect n'est touché que s'il est PRÉSENT dans le body : la clé absente
// laisse la valeur enregistrée, la clé à `null` l'efface. Sans cette règle,
// enregistrer les choix d'une Sélection effacerait le renommage du champ (et
// inversement), les deux gestes vivant dans deux endroits de la modale.
router.put('/:erpTable/native/:fieldId', (req, res) => {
  const p = nativeParams(req, res)
  if (!p) return
  // Cette colonne porte-t-elle déjà un VRAI champ (adopté, converti en
  // lookup/rollup…) ? Alors ce n'est plus une personnalisation cosmétique : la
  // personnaliser ici écraserait `kind` et remettrait le champ en 'native',
  // cassant sa configuration jusqu'au prochain démarrage. On refuse — le champ
  // s'édite par sa propre fiche (PUT /api/custom-fields/:id).
  const owner = db.prepare(
    `SELECT kind FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(p.erpTable, p.fieldId)
  if (owner && owner.kind && owner.kind !== 'native') {
    return res.status(409).json({ error: 'Champ personnalisé — à modifier depuis sa fiche de champ, pas comme champ natif' })
  }
  const { label, type, decimals, country_code } = req.body || {}
  const has = key => Object.prototype.hasOwnProperty.call(req.body || {}, key)
  const hasOptions = has('options')
  let cleanOptions = null
  if (hasOptions) {
    try { cleanOptions = normalizeNativeSelectOptions(req.body.options) }
    catch (e) { return res.status(400).json({ error: e.message }) }
  }

  let cleanLabel = null
  if (label != null) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 120) {
      return res.status(400).json({ error: 'Libellé invalide (1 à 120 caractères)' })
    }
    cleanLabel = label.trim()
  }
  let cleanType = null
  if (type != null) {
    cleanType = type === 'boolean' ? 'checkbox' : type
    if (!isNativeType(cleanType)) {
      return res.status(400).json({ error: `Type invalide (${[...NATIVE_TYPES].join(', ')}, link:<table>)` })
    }
  }
  let cleanDecimals = null
  if (decimals != null) {
    const d = Number(decimals)
    if (!Number.isInteger(d) || d < 0 || d > 5) return res.status(400).json({ error: 'Décimales invalides (0 à 5)' })
    cleanDecimals = d
  }
  let cleanCountryCode = null
  if (country_code != null) {
    if (country_code !== 'show' && country_code !== 'hide') {
      return res.status(400).json({ error: "Indicatif invalide ('show' ou 'hide')" })
    }
    cleanCountryCode = country_code
  }
  const hasDescription = has('description')
  let cleanDescription = null
  if (hasDescription) {
    try { cleanDescription = normalizeDescription(req.body.description) }
    catch (e) { return res.status(400).json({ error: e.message }) }
  }
  if (cleanLabel == null && cleanType == null && cleanCountryCode == null && !hasOptions && !hasDescription) {
    return res.status(400).json({ error: 'Rien à enregistrer : libellé, type, indicatif, choix ou description requis' })
  }

  // Unicité du libellé dans la table : deux champs homonymes rendent tout
  // sélecteur de champ ambigu (filtres, formules, mapping Airtable).
  if (cleanLabel != null) {
    const conflict = findLabelConflict(p.erpTable, cleanLabel, { fieldId: p.fieldId })
    if (conflict) return res.status(409).json({ error: labelConflictError(conflict) })
  }

  // Le sort_order existant est préservé : renommer un champ ne doit jamais le
  // déplacer. Une ligne absente naît sans ordre explicite (NULL).
  const existing = db.prepare(
    `SELECT id, sort_order, name, type, decimals, country_code, options, description FROM custom_fields WHERE erp_table=? AND column_name=?`
  ).get(p.erpTable, p.fieldId)
  // Aspect absent du body → on garde ce qui est déjà enregistré.
  const nextOptions = hasOptions ? mergeNativeOptions(existing?.options, cleanOptions) : (existing?.options || null)
  const nextName = has('label') ? (cleanLabel || '') : (existing?.name || '')
  const nextType = has('type') ? (cleanType || '') : (existing?.type || '')
  const nextDecimals = has('decimals') ? cleanDecimals : (existing?.decimals ?? null)
  const nextCountryCode = has('country_code') ? cleanCountryCode : (existing?.country_code || null)
  const nextDescription = hasDescription ? cleanDescription : (existing?.description || null)

  // Personnaliser un champ purgé le fait revenir : geste explicite, la pierre
  // tombale n'a plus de raison d'être (sinon le champ resterait invisible sans
  // que rien ne l'explique).
  clearFieldTombstone(p.erpTable, p.fieldId)

  if (existing) {
    db.prepare(`
      UPDATE custom_fields
      SET name=?, type=?, decimals=?, country_code=?, options=?, description=?, kind='native', deleted_at=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(nextName, nextType, nextDecimals, nextCountryCode, nextOptions, nextDescription, existing.id)
  } else {
    // sort_order explicitement NULL : la colonne a un DEFAULT 0, or un champ
    // seulement renommé n'a AUCUN ordre choisi. Avec 0, applyFieldOrder le
    // considérerait comme ordonné et le ferait remonter en tête du tableau.
    db.prepare(`
      INSERT INTO custom_fields
        (id, erp_table, name, column_name, type, decimals, country_code, options, description, sort_order, kind, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'native', 'native')
    `).run(newRecordId(), p.erpTable, nextName, p.fieldId, nextType, nextDecimals, nextCountryCode, nextOptions, nextDescription)
  }

  res.json({ data: { field_id: p.fieldId, label: nextName || null, type: nextType || null, decimals: nextDecimals, country_code: nextCountryCode, options: nextOptions, description: nextDescription } })
})

// PATCH /:erpTable/native/order — retirée avec le réordonnancement des champs
// de la page de configuration (/champs/:table) : plus aucun client ne l'appelle.
// Les `sort_order` déjà en base restent lus par la liste des champs natifs et
// pilotent toujours l'ordre d'affichage (applyFieldOrder côté client).

// Supprimer un champ natif = une VRAIE suppression : la ligne custom_fields est
// soft-deletée et part à la corbeille (Admin → Corbeille), exactement comme un
// champ perso. Le champ ne survit nulle part dans l'interface — pas de section
// « champs masqués » où il traînerait. Seule la colonne SQL reste : des routes
// serveur, des syncs et des fiches détail la lisent, et la donnée n'est jamais
// détruite.
//
// Le drapeau du body reste `hidden` : côté client un champ supprimé se lit comme
// un champ masqué (il sort des tableaux, panneaux, filtres, tris, sélecteurs), et
// c'est sous ce drapeau que le GET ci-dessus republie les lignes supprimées.
// Body : { hidden: true|false, label? } — `label` sert de libellé de corbeille
// pour un natif jamais renommé (le serveur ne connaît pas tableDefs.js).
router.patch('/:erpTable/native/:fieldId/hidden', (req, res) => {
  const p = nativeParams(req, res)
  if (!p) return
  const hidden = req.body?.hidden
  if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden doit être un booléen' })
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 120) : ''

  // « Remettre » un champ (hidden:false) efface aussi sa pierre tombale de
  // purge : sans ça, un champ purgé puis remis resterait masqué pour toujours.
  if (!hidden) clearFieldTombstone(p.erpTable, p.fieldId)

  const existing = db.prepare(
    `SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`
  ).get(p.erpTable, p.fieldId)
  if (existing) {
    // `name` complété seulement s'il est vide : un champ renommé garde son nom.
    db.prepare(`
      UPDATE custom_fields
      SET hidden=0,
          name = CASE WHEN name IS NULL OR name='' THEN ? ELSE name END,
          deleted_at=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(label, hidden ? new Date().toISOString() : null, existing.id)
  } else if (hidden) {
    // sort_order NULL : supprimer un champ ne choisit pas sa position (voir le PUT).
    db.prepare(`
      INSERT INTO custom_fields
        (id, erp_table, name, column_name, type, sort_order, hidden, kind, source, deleted_at)
      VALUES (?, ?, ?, ?, '', NULL, 0, 'native', 'native', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(newRecordId(), p.erpTable, label, p.fieldId)
  }
  res.json({ data: { field_id: p.fieldId, hidden } })
})

// Retour à l'original : la ligne est SUPPRIMÉE, pas soft-deletée — la contrainte
// UNIQUE(erp_table, column_name) ne distingue pas les lignes supprimées, une
// ligne fantôme bloquerait toute repersonnalisation ultérieure du même champ.
// L'ordre est conservé s'il en existe un (on ne remet pas le champ à sa place
// d'origine juste parce qu'on annule un renommage).
router.delete('/:erpTable/native/:fieldId', (req, res) => {
  const p = nativeParams(req, res)
  if (!p) return
  const row = db.prepare(
    `SELECT id, sort_order, hidden FROM custom_fields WHERE erp_table=? AND column_name=? AND kind='native'`
  ).get(p.erpTable, p.fieldId)
  if (!row) return res.json({ data: { field_id: p.fieldId, reset: true } })
  // Une ligne qui porte encore un ordre choisi ou un masquage doit survivre au
  // retour à l'original : ce sont des décisions distinctes du renommage/type.
  if (row.sort_order != null || row.hidden === 1) {
    db.prepare(`
      UPDATE custom_fields SET name='', type='', decimals=NULL, country_code=NULL, options=NULL, description=NULL,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(row.id)
  } else {
    db.prepare(`DELETE FROM custom_fields WHERE id=?`).run(row.id)
  }
  res.json({ data: { field_id: p.fieldId, reset: true } })
})

// Champs auto-remplis (parité Airtable), déclarés AVANT FIELD_KINDS qui les
// parcourt à l'évaluation du module :
//   - created_time       : date de création (colonne created_at)
//   - last_modified_time : date de dernière modification (colonne updated_at)
//   - created_by         : utilisateur ayant créé l'enregistrement (activity_log)
//   - last_modified_by   : dernier utilisateur ayant modifié (activity_log)
const AUTO_TYPES = {
  created_time:       { result_type: 'date', needsCreatedAt: true },
  last_modified_time: { result_type: 'date', needsUpdatedAt: true },
  created_by:         { result_type: 'text', needsEntity: true },
  last_modified_by:   { result_type: 'text', needsEntity: true },
}

// ── Création d'un champ — une seule porte d'entrée ───────────────────────────
//
// Il y avait sept routes de création (`/`, `/formula`, `/lookup`, `/rollup`,
// `/auto`, `/button`, `/link`), chacune refaisant les mêmes gestes : contrôle de
// la table, nom requis, calcul du `column_name`, `MAX(sort_order)`, insertion,
// régénération de la vue. Tout ça vit maintenant ici une seule fois ; il ne
// reste, par `kind`, que ce qui lui est PROPRE : sa validation et les colonnes
// qu'il remplit. C'est aussi ce qui rend la conversion de `kind` (PUT plus bas)
// bon marché — convertir, c'est rejouer la validation d'un autre kind.
//
// Body : { kind?, name, … } — `kind` absent = 'data' (le cas courant).

class FieldError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const fieldError = (status, message) => new FieldError(status, message)

// 'url' est un type d'AFFICHAGE : la valeur reste du texte (colonne/vue
// inchangées), elle est simplement rendue en lien cliquable côté client quand
// c'est une URL valide.
const RESULT_TYPES = ['text', 'number', 'date', 'url']
const RESULT_TYPE_ERROR = "result_type doit être 'text', 'number', 'date' ou 'url'"
function requireResultType(value, { fallback = null } = {}) {
  const rt = value || fallback
  if (!RESULT_TYPES.includes(rt)) {
    throw fieldError(400, RESULT_TYPE_ERROR)
  }
  return rt
}

// Chaque kind valide son corps de requête et retourne les colonnes qui lui sont
// propres. `virtual: true` = pas de colonne physique (la valeur vit dans la vue
// <table>_v ou, pour un bouton, nulle part).
const FIELD_KINDS = {
  data: {
    virtual: false,
    build(erpTable, body) {
      const type = body?.type
      if (!DATA_TYPES.has(type)) {
        return { error: `Type doit être l'un de : ${[...DATA_TYPES].join(', ')}` }
      }
      let options = null
      if (type === 'single_select' || type === 'multi_select') options = normalizeSelectOptions(body?.options).json
      else if (type === 'duration') options = normalizeDurationOptions(body?.options).json
      else if (type === 'currency') options = normalizeCurrencyOptions(body?.options).json
      else if (type === 'phone') options = normalizePhoneOptions(body?.options).json
      else if (type === 'date') options = normalizeDateOptions(body?.options).json

      let decimals = null
      if (type === 'number' || type === 'currency') {
        const raw = body?.decimals
        decimals = (raw === undefined || raw === null || raw === '') && type === 'currency' ? 2 : parseInt(raw)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 5) {
          return { error: 'Décimales doit être entre 0 et 5' }
        }
      }
      let defaultValue = null
      if (['text', 'number', 'currency', 'url', 'phone', 'duration', 'checkbox'].includes(type)) {
        defaultValue = normalizeDefaultValue(body?.default_value, type)
      }
      // SQLite n'est pas typé strictement : number/currency/duration → REAL
      // (duration en secondes), checkbox → INTEGER (0/1), le reste → TEXT.
      const sqlType = (type === 'number' || type === 'currency' || type === 'duration')
        ? 'REAL'
        : (type === 'checkbox' ? 'INTEGER' : 'TEXT')
      return { type, sqlType, columns: { decimals, options, default_value: defaultValue } }
    },
  },

  formula: {
    virtual: true, regenerate: true,
    build(erpTable, body) {
      const expr = String(body?.formula_expr || '').trim()
      const resultType = requireResultType(body?.result_type)
      validateFormulaExpr(expr)
      // Rejette dès la création une formule référençant une colonne inexistante,
      // plutôt que de créer un champ qui afficherait #ERROR.
      validateFormulaReferences(expr, erpTable)
      return {
        type: resultType === 'number' ? 'number' : 'text',
        columns: { formula_expr: expr, result_type: resultType },
      }
    },
  },

  lookup: {
    virtual: true, regenerate: true,
    build(erpTable, body) {
      const lookup = {
        lookup_fk: body?.lookup_fk,
        lookup_target_table: body?.lookup_target_table,
        lookup_target_column: body?.lookup_target_column,
      }
      const resultType = requireResultType(body?.result_type)
      validateLookup(lookup, erpTable)
      return { type: resultType === 'number' ? 'number' : 'text', columns: { ...lookup, result_type: resultType } }
    },
  },

  rollup: {
    virtual: true, regenerate: true,
    build(erpTable, body) {
      const rollup = {
        rollup_target_table: body?.rollup_target_table,
        rollup_target_fk: body?.rollup_target_fk,
        // COUNT n'a pas besoin de colonne — on normalise '' → null.
        rollup_target_column: body?.rollup_target_column || null,
        rollup_agg: body?.rollup_agg,
      }
      // Les agrégats sont numériques par défaut.
      const resultType = requireResultType(body?.result_type, { fallback: 'number' })
      validateRollup(rollup, erpTable)
      return {
        type: resultType === 'number' ? 'number' : 'text',
        columns: { ...rollup, rollup_agg: String(rollup.rollup_agg).toUpperCase(), result_type: resultType },
      }
    },
  },

  button: {
    virtual: true, regenerate: false,
    build(erpTable, body) {
      // Pas de colonne physique ni de contribution à la vue : c'est une action,
      // pas une valeur (regenerateView ignore kind='button').
      return { type: 'button', columns: { options: normalizeButtonOptions(body?.options).json } }
    },
  },
}

// Les quatre champs auto-remplis partagent toute leur mécanique : seul diffère
// ce qu'exige la table (colonne created_at/updated_at, ou un mapping activity_log).
for (const [autoType, spec] of Object.entries(AUTO_TYPES)) {
  FIELD_KINDS[autoType] = {
    virtual: true, regenerate: true,
    build(erpTable) {
      const cols = () => db.pragma(`table_info(${erpTable})`).map(c => c.name)
      if (spec.needsCreatedAt && !cols().includes('created_at')) {
        return { error: `Table ${erpTable} sans colonne created_at — type non supporté` }
      }
      if (spec.needsUpdatedAt && !cols().includes('updated_at')) {
        return { error: `Table ${erpTable} sans colonne updated_at — type non supporté` }
      }
      if (spec.needsEntity && !ACTIVITY_ENTITY_MAP[erpTable]) {
        return { error: `Attribution (activity_log) non disponible pour ${erpTable}` }
      }
      return { type: 'text', columns: { result_type: spec.result_type } }
    },
  }
}

const CF_INSERT_COLUMNS = [
  'decimals', 'options', 'default_value', 'formula_expr', 'result_type',
  'lookup_fk', 'lookup_target_table', 'lookup_target_column',
  'rollup_target_table', 'rollup_target_fk', 'rollup_target_column', 'rollup_agg',
  'link_target_table', 'link_group_id', 'link_role', 'link_single',
  'source', 'airtable_mapping_id', 'description',
]

function nextSortOrder(erpTable) {
  const row = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  return (row?.m ?? -1) + 1
}

// Insère une ligne custom_fields à partir des colonnes propres au kind. Retourne
// l'id créé. N'ouvre PAS de transaction : l'appelant décide de la portée.
function insertFieldRow({ id, erpTable, name, columnName, type, kind, sortOrder, columns = {} }) {
  const cols = ['id', 'erp_table', 'name', 'column_name', 'type', 'kind', 'sort_order']
  const vals = [id, erpTable, name, columnName, type, kind, sortOrder]
  for (const c of CF_INSERT_COLUMNS) {
    if (columns[c] !== undefined) { cols.push(c); vals.push(columns[c]) }
  }
  db.prepare(
    `INSERT INTO custom_fields (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...vals)
  return id
}

const FIELD_SELECT = `
  SELECT id, name, column_name, type, kind, decimals, sort_order, options, default_value,
         formula_expr, result_type, lookup_fk, lookup_target_table, lookup_target_column,
         rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg,
         link_target_table, link_group_id, link_role, link_single, source, airtable_mapping_id, description
  FROM custom_fields WHERE id=?`

// Crée un champ de n'importe quel kind. Lève une FieldError (status + message)
// en cas de refus. `adoptColumn` : colonne physique déjà existante à adopter
// plutôt que d'en créer une (flux de mapping Airtable) — aucun ALTER TABLE.
function createField(erpTable, body, { adoptColumn = null, extra = {} } = {}) {
  if (!ALLOWED_TABLES.has(erpTable)) throw fieldError(400, 'Table non supportée')
  const kind = body?.kind || 'data'
  const spec = FIELD_KINDS[kind]
  if (!spec) throw fieldError(400, `Type de champ inconnu : ${kind}`)

  const name = String(body?.name || '').trim()
  if (!name) throw fieldError(400, 'Nom requis')
  // Unicité du libellé : deux champs homonymes rendent ambigu tout sélecteur de
  // champ (filtres, formules, mapping). Le contrôle était jusqu'ici absent de
  // plusieurs des anciennes routes de création.
  const conflict = findLabelConflict(erpTable, name)
  if (conflict) throw fieldError(409, labelConflictError(conflict))

  let built
  try { built = spec.build(erpTable, body) }
  catch (e) { throw e instanceof FieldError ? e : fieldError(400, e.message) }
  if (built?.error) throw fieldError(400, built.error)

  // Description facultative (infobulle de l'en-tête de colonne), tous kinds.
  let description
  try { description = normalizeDescription(body?.description) }
  catch (e) { throw fieldError(400, e.message) }

  const columnName = adoptColumn
    || (spec.virtual
      ? ensureUniqueVirtualColumnName(erpTable, slugify(name))
      : ensureUniqueColumnName(erpTable, slugify(name)))

  const id = newRecordId()
  const sortOrder = nextSortOrder(erpTable)
  const tx = db.transaction(() => {
    if (!spec.virtual && !adoptColumn) {
      db.exec(`ALTER TABLE ${erpTable} ADD COLUMN ${columnName} ${built.sqlType}`)
    }
    insertFieldRow({
      id, erpTable, name, columnName, type: built.type, kind, sortOrder,
      columns: { ...built.columns, ...(description ? { description } : {}), ...extra },
    })
    if (spec.regenerate) {
      // La régénération résout les dépendances entre champs et détecte les
      // cycles. Si CE champ tombe en erreur, on annule la création : mieux vaut
      // un message précis qu'un champ qui naît en #ERROR.
      const { errors } = regenerateView(erpTable)
      const mine = errors?.find(e => e.id === id)
      if (mine) throw fieldError(400, mine.message)
    }
  })
  tx()
  return db.prepare(FIELD_SELECT).get(id)
}

// POST /api/custom-fields/:erpTable — crée un champ de n'importe quel kind.
// Body : { kind?, name, … } (voir FIELD_KINDS). `kind` absent = 'data'.
//
// Cas particulier : `kind: 'link'` crée DEUX champs (le champ et son inverse sur
// la table cible) partageant un link_group_id — la table de jonction
// custom_field_links est la seule source de vérité, donc les deux côtés restent
// synchronisés. Body : { name, link_target_table, relationship, create_inverse?, inverse_name? }
router.post('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  try {
    if ((req.body?.kind) === 'link') return res.status(201).json(createLinkPair(erpTable, req.body))
    res.status(201).json(createField(erpTable, req.body))
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

function createLinkPair(erpTable, body) {
  if (!ALLOWED_TABLES.has(erpTable)) throw fieldError(400, 'Table non supportée')
  const name = String(body?.name || '').trim()
  const targetTable = String(body?.link_target_table || '').trim()
  const relationship = body?.relationship || 'one_to_many'
  const createInverse = body?.create_inverse !== false
  if (!name) throw fieldError(400, 'Nom requis')
  if (!LINK_RELATIONSHIPS[relationship]) {
    throw fieldError(400, "relationship doit être 'one_to_one', 'one_to_many' ou 'many_to_many'")
  }
  if (!ALLOWED_TABLES.has(targetTable) || !LINK_TARGET_WHITELIST.has(targetTable)) {
    throw fieldError(400, 'Table cible non autorisée pour une liaison')
  }
  if (targetTable === erpTable) throw fieldError(400, 'Auto-liaison (même table) non supportée')
  const conflict = findLabelConflict(erpTable, name)
  if (conflict) throw fieldError(409, labelConflictError(conflict))
  try { validateLink({ link_target_table: targetTable }, erpTable) }
  catch (e) { throw fieldError(400, e.message) }

  const card = LINK_RELATIONSHIPS[relationship]
  const groupId = newRecordId()
  const sourceId = newRecordId()
  const sourceCol = ensureUniqueVirtualColumnName(erpTable, slugify(name))
  // Nom du champ inverse : par défaut, le nom de la table source.
  const inverseName = String(body?.inverse_name || '').trim() || erpTable
  const inverseCol = createInverse ? ensureUniqueVirtualColumnName(targetTable, slugify(inverseName)) : null

  const tx = db.transaction(() => {
    insertFieldRow({
      id: sourceId, erpTable, name, columnName: sourceCol, type: 'link', kind: 'link',
      sortOrder: nextSortOrder(erpTable),
      columns: { result_type: 'text', link_target_table: targetTable, link_group_id: groupId, link_role: 'source', link_single: card.source_single },
    })
    if (createInverse) {
      insertFieldRow({
        id: newRecordId(), erpTable: targetTable, name: inverseName, columnName: inverseCol, type: 'link', kind: 'link',
        sortOrder: nextSortOrder(targetTable),
        columns: { result_type: 'text', link_target_table: erpTable, link_group_id: groupId, link_role: 'target', link_single: card.inverse_single },
      })
    }
    regenerateView(erpTable)
    if (createInverse) regenerateView(targetTable)
  })
  tx()
  return db.prepare(FIELD_SELECT).get(sourceId)
}



// POST /api/custom-fields/:erpTable/duplicate — duplique un champ.
// Body : { field_id, with_values? (défaut true) }
//   • field_id = column_name du champ source (champ perso OU colonne native).
//
// Deux règles non négociables :
//   1. la copie N'HÉRITE JAMAIS du lien vers une source externe (Airtable/Stripe).
//      Deux colonnes branchées sur le même champ distant s'écraseraient l'une
//      l'autre à chaque sync — la copie naît en saisie manuelle (source='native',
//      aucun airtable_mapping_id).
//   2. la copie a toujours sa PROPRE colonne physique (cf_*) : on ne partage
//      jamais une colonne entre deux champs.
router.post('/:erpTable/duplicate', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const fieldId = String(req.body?.field_id || '').trim()
  if (!fieldId || !NATIVE_FIELD_RE.test(fieldId)) return res.status(400).json({ error: 'field_id requis' })
  const withValues = req.body?.with_values !== false

  const src = db.prepare(
    `SELECT * FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`
  ).get(erpTable, fieldId)

  // Champs à définition (formule/lookup/rollup) : rien à copier côté données,
  // seule l'expression est reproduite. Les liaisons sont exclues : dupliquer un
  // champ link exigerait de créer un nouveau groupe ET son champ inverse sur la
  // table cible — c'est une création à part entière, pas une copie.
  if (src && src.kind === 'link') {
    return res.status(400).json({ error: 'Un champ de liaison ne se duplique pas — créez-en un nouveau depuis la modale' })
  }
  const isVirtual = !!src && src.kind !== 'data' && src.kind !== 'native'

  const physical = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  if (!isVirtual && !physical.has(fieldId)) {
    // Colonne calculée par la requête de la route (ex. company_name via JOIN,
    // has_shipping_address via CASE) : aucune donnée à copier, et la copie
    // n'aurait aucun moyen d'être alimentée.
    return res.status(400).json({ error: 'Ce champ est calculé par le serveur — il n\'a pas de colonne à dupliquer' })
  }

  // Nom : « X (copie) », puis « (copie 2) », … jusqu'à trouver un libellé libre.
  // `label` vient du client : le libellé d'une colonne native vit dans
  // tableDefs.js, côté client — sans lui, la copie s'appellerait « name (copie) »
  // au lieu de « Projet (copie) ».
  const baseName = String(req.body?.label || '').trim()
    || (src && src.name) || fieldId
  let name = `${baseName} (copie)`
  for (let i = 2; findLabelConflict(erpTable, name); i++) {
    name = `${baseName} (copie ${i})`
    if (i > 50) return res.status(400).json({ error: 'Impossible de nommer la copie' })
  }

  const type = (src && src.type) || 'text'
  const id = newRecordId()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  if (isVirtual) {
    const columnName = ensureUniqueVirtualColumnName(erpTable, slugify(name))
    db.prepare(`
      INSERT INTO custom_fields
        (id, erp_table, name, column_name, type, decimals, sort_order, options, kind,
         formula_expr, lookup_fk, lookup_target_table, lookup_target_column, result_type,
         rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, description, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'native')
    `).run(
      id, erpTable, name, columnName, type, src.decimals, sortOrder, src.options, src.kind,
      src.formula_expr, src.lookup_fk, src.lookup_target_table, src.lookup_target_column, src.result_type,
      src.rollup_target_table, src.rollup_target_fk, src.rollup_target_column, src.rollup_agg, src.description ?? null,
    )
    regenerateView(erpTable)
  } else {
    const columnName = ensureUniqueColumnName(erpTable, slugify(name))
    const sqlType = (type === 'number' || type === 'currency' || type === 'duration')
      ? 'REAL'
      : (type === 'checkbox' ? 'INTEGER' : 'TEXT')
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE ${erpTable} ADD COLUMN ${columnName} ${sqlType}`)
      if (withValues) db.exec(`UPDATE ${erpTable} SET ${columnName} = ${fieldId}`)
      db.prepare(`
        INSERT INTO custom_fields
          (id, erp_table, name, column_name, type, decimals, sort_order, options, default_value, description, kind, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,'data','native')
      `).run(id, erpTable, name, columnName, type, src?.decimals ?? null, sortOrder,
        src?.options ?? null, src?.default_value ?? null, src?.description ?? null)
    })
    tx()
  }

  const created = db.prepare(
    `SELECT id, name, column_name, type, decimals, sort_order, options, default_value, kind, source
     FROM custom_fields WHERE id=?`
  ).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/adopt — « adopte » une colonne physique déjà
// existante sur la table (issue d'un mapping Airtable, ou orpheline) plutôt que
// d'en créer une nouvelle. Contrairement à POST /:erpTable, ne fait AUCUN
// ALTER TABLE : la colonne existe déjà, on ne fait que poser la métadonnée de
// rendu (source='airtable'). Utilisé par le flux de mapping Airtable
// (routes/connectors.js) après matérialisation d'une colonne.
// Body : { column_name, name, type, options?, airtable_mapping_id? }
const ADOPTABLE_TYPES = new Set(['text', 'long_text', 'number', 'date', 'single_select', 'multi_select', 'checkbox'])
const SYSTEM_COLUMNS = new Set(['id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at', 'rowid', 'oid', '_rowid_'])

router.post('/:erpTable/adopt', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const columnName = String(req.body?.column_name || '').trim()
  const name = String(req.body?.name || '').trim()
  const type = req.body?.type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!columnName) return res.status(400).json({ error: 'column_name requis' })
  if (!ADOPTABLE_TYPES.has(type)) {
    return res.status(400).json({ error: `Type non supporté pour une colonne adoptée : ${[...ADOPTABLE_TYPES].join(', ')}` })
  }
  if (SYSTEM_COLUMNS.has(columnName)) return res.status(400).json({ error: 'Colonne système — non adoptable' })
  const liveCols = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  if (!liveCols.has(columnName)) return res.status(400).json({ error: `Colonne "${columnName}" introuvable sur ${erpTable}` })
  const dupe = db.prepare(`SELECT 1 FROM custom_fields WHERE erp_table=? AND column_name=? AND deleted_at IS NULL`).get(erpTable, columnName)
  if (dupe) return res.status(400).json({ error: 'Cette colonne a déjà un champ actif' })

  let optionsJson = null
  if (type === 'single_select' || type === 'multi_select') {
    try { optionsJson = normalizeSelectOptions(req.body?.options).json }
    catch (e) { return res.status(400).json({ error: e.message }) }
  }

  const id = newRecordId()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1
  const airtableMappingId = req.body?.airtable_mapping_id || null

  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, sort_order, options, source, airtable_mapping_id)
    VALUES (?,?,?,?,?, 'data', ?, ?, 'airtable', ?)
  `).run(id, erpTable, name, columnName, type, sortOrder, optionsJson, airtableMappingId)

  const created = db.prepare(
    `SELECT id, name, column_name, type, decimals, sort_order, options, source, airtable_mapping_id FROM custom_fields WHERE id=?`
  ).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/formula/preview — évalue une expression
// formule sur N vrais records SANS rien persister (aperçu live « Tester »).
// Body : { formula_expr, limit? }. Lecture seule.
router.post('/:erpTable/formula/preview', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const formulaExpr = String(req.body?.formula_expr || '').trim()
  if (!formulaExpr) return res.status(400).json({ error: 'Expression requise' })
  try {
    const rows = previewFormula(erpTable, formulaExpr, req.body?.limit)
    res.json({ rows })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})



// POST /api/custom-fields/:erpTable/auto — crée un champ auto-rempli (lecture
// seule), exposé uniquement via la VUE <table>_v. Parité Airtable :
//   - created_time       : date de création (colonne created_at)
//   - last_modified_time : date de dernière modification (colonne updated_at)
//   - created_by         : utilisateur ayant créé l'enregistrement (activity_log)
//   - last_modified_by   : dernier utilisateur ayant modifié (activity_log)


// POST /api/custom-fields/button/:fieldId/run — déclenche l'automation câblée sur
// un champ Bouton, pour UN record précis (la ligne où l'utilisateur a cliqué).
// Bypass du prédicat de déclenchement + pas de dedup (bouton répétable).
router.post('/button/:fieldId/run', async (req, res) => {
  const field = db.prepare(`SELECT * FROM custom_fields WHERE id=? AND deleted_at IS NULL`).get(req.params.fieldId)
  if (!field) return res.status(404).json({ error: 'Champ introuvable' })
  if (field.kind !== 'button') return res.status(400).json({ error: 'Ce champ n\'est pas un bouton' })
  const recordId = String(req.body?.record_id || '').trim()
  if (!recordId) return res.status(400).json({ error: 'record_id requis' })
  let opts
  try { opts = JSON.parse(field.options || '{}') } catch { opts = {} }
  if (!opts.automation_id) return res.status(400).json({ error: 'Bouton non configuré (aucune automation)' })
  try {
    const out = await runRuleActionForRecord(opts.automation_id, field.erp_table, recordId)
    res.json({ status: 'success', ...out })
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message })
  }
})

// Cardinalité d'un champ link → (single de CE côté, single du côté INVERSE).
//   one_to_one   : 1 ↔ 1
//   one_to_many  : ce record lie PLUSIEURS cibles, chaque cible n'a qu'un parent
//   many_to_many : N ↔ N
const LINK_RELATIONSHIPS = {
  one_to_one:   { source_single: 1, inverse_single: 1 },
  one_to_many:  { source_single: 0, inverse_single: 1 },
  many_to_many: { source_single: 0, inverse_single: 0 },
}


// GET /api/custom-fields/link/:fieldId/value?record_id=… — records liés à un
// record pour un champ link : tableau [{id,label}].
router.get('/link/:fieldId/value', (req, res) => {
  const field = db.prepare(`SELECT * FROM custom_fields WHERE id=? AND deleted_at IS NULL`).get(req.params.fieldId)
  if (!field) return res.status(404).json({ error: 'Champ introuvable' })
  if (field.kind !== 'link') return res.status(400).json({ error: 'Ce champ n\'est pas une liaison' })
  const recordId = String(req.query?.record_id || '').trim()
  if (!recordId) return res.status(400).json({ error: 'record_id requis' })
  try { res.json({ data: readLinkValue(field, recordId) }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// PUT /api/custom-fields/link/:fieldId/value — remplace l'ensemble des records
// liés à un record. Body : { record_id, target_ids: [] }. La modification se
// reflète immédiatement sur le champ inverse (jonction partagée).
router.put('/link/:fieldId/value', (req, res) => {
  const field = db.prepare(`SELECT * FROM custom_fields WHERE id=? AND deleted_at IS NULL`).get(req.params.fieldId)
  if (!field) return res.status(404).json({ error: 'Champ introuvable' })
  if (field.kind !== 'link') return res.status(400).json({ error: 'Ce champ n\'est pas une liaison' })
  const recordId = String(req.body?.record_id || '').trim()
  if (!recordId) return res.status(400).json({ error: 'record_id requis' })
  const targetIds = Array.isArray(req.body?.target_ids) ? req.body.target_ids : []
  try { res.json({ data: setLinkValue(field, recordId, targetIds) }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// GET /api/custom-fields/link/:fieldId/options?q=… — records sélectionnables de
// la table cible (id + label) pour le picker.
router.get('/link/:fieldId/options', (req, res) => {
  const field = db.prepare(`SELECT * FROM custom_fields WHERE id=? AND deleted_at IS NULL`).get(req.params.fieldId)
  if (!field) return res.status(404).json({ error: 'Champ introuvable' })
  if (field.kind !== 'link') return res.status(400).json({ error: 'Ce champ n\'est pas une liaison' })
  try { res.json({ data: getLinkOptions(field, req.query?.q, req.query?.limit) }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// Types de données valides pour un champ kind='data' (aligné sur POST :erpTable).
// 'attachment' : fichiers déposés (PDF, images…). La colonne TEXT porte un
// tableau JSON de descripteurs ; les octets vivent sous uploads/attachments/
// fields/ et s'écrivent par la route dédiée (routes/custom-field-files.js).
const DATA_TYPES = new Set(['text', 'long_text', 'number', 'currency', 'url', 'phone', 'duration', 'date', 'single_select', 'multi_select', 'checkbox', 'attachment'])

// Options propres à chaque type de donnée. Les options n'appartiennent jamais au
// champ mais à son TYPE : des choix de sélection sous un champ devenu « Nombre »
// ne veulent plus rien dire, donc un changement de type les remplace toujours.
function optionsJsonFor(type, raw) {
  if (type === 'single_select' || type === 'multi_select') return normalizeSelectOptions(raw).json
  if (type === 'duration') return normalizeDurationOptions(raw).json
  if (type === 'currency') return normalizeCurrencyOptions(raw).json
  if (type === 'phone') return normalizePhoneOptions(raw).json
  if (type === 'date') return normalizeDateOptions(raw).json
  return null
}
// Options par défaut d'un type quand le changement n'en fournit pas. Une
// sélection sans liste reste sans liste : ses choix se dérivent des données
// (fieldTypeConvert.js) ou se saisissent ensuite.
function defaultOptionsJsonFor(type) {
  if (type === 'single_select' || type === 'multi_select') return null
  try { return optionsJsonFor(type, null) } catch { return null }
}

// PUT /api/custom-fields/:id — modifie nom, décimales, et (selon le kind)
// l'expression formule ou la config lookup. Le `column_name` et le `kind` ne
// peuvent jamais changer.
//
// Le `type` d'un champ de donnée, lui, se change librement — et les VALEURS
// suivent (services/fieldTypeConvert.js) : chaque valeur passe par un pivot
// texte puis est relue dans le type visé. Ce qui ne se relit pas n'est jamais
// écrasé en douce : la route répond 409 avec le décompte et des exemples, et
// l'appelant outrepasse avec `force_convert: true` (ces valeurs-là sont alors
// vidées). Si l'affinité SQLite de la colonne change (texte ↔ nombre ↔ booléen),
// la colonne physique est refaite — sans quoi un champ « Nombre » trierait
// encore ses valeurs comme du texte.
router.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  if (existing.deleted_at) return res.status(400).json({ error: 'Champ supprimé — restaurer d\'abord depuis la corbeille' })

  const updates = []
  const values = []
  let viewDirty = false

  // ── Conversion de kind ────────────────────────────────────────────────────
  // Changer la NATURE d'un champ : une colonne saisie à la main devient une
  // formule, un lookup, un rollup — ou l'inverse. La validation est celle de la
  // création (FIELD_KINDS), rejouée pour le kind visé : c'est ce que la route de
  // création unique rend possible sans code neuf.
  //
  // Ce qui n'arrive JAMAIS : la destruction de la colonne physique. Elle survit
  // intacte, simplement retirée de la vue (voir regenerateView) — donc la
  // conversion inverse rend les valeurs telles quelles. En contrepartie, une
  // colonne alimentée par Airtable voit son import coupé : sinon la sync
  // continuerait d'écrire sous un champ devenu calculé.
  const wantedKind = req.body?.kind
  if (wantedKind && wantedKind !== existing.kind) {
    if (existing.kind === 'link' || wantedKind === 'link') {
      return res.status(400).json({ error: 'Un champ de liaison ne se convertit pas — créez le champ voulu et supprimez celui-ci' })
    }
    const spec = FIELD_KINDS[wantedKind]
    if (!spec) return res.status(400).json({ error: `Type de champ inconnu : ${wantedKind}` })

    let built
    try { built = spec.build(existing.erp_table, { ...req.body, name: req.body?.name ?? existing.name }) }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }) }
    if (built?.error) return res.status(400).json({ error: built.error })

    const physical = new Set(db.pragma(`table_info(${existing.erp_table})`).map(c => c.name))
    if (!spec.virtual && !physical.has(existing.column_name)) {
      // Retour vers un champ saisissable dont la colonne n'a jamais existé
      // (champ né virtuel) : il faut la créer.
      db.exec(`ALTER TABLE ${existing.erp_table} ADD COLUMN ${existing.column_name} ${built.sqlType}`)
    }
    if (spec.virtual && existing.kind === 'data') {
      db.prepare(
        `UPDATE airtable_field_mappings SET import_disabled=1 WHERE erp_table=? AND column_name=?`
      ).run(existing.erp_table, existing.column_name)
    }

    updates.push('kind=?'); values.push(wantedKind)
    updates.push('type=?'); values.push(built.type)
    // Les colonnes de l'ancien kind sont remises à NULL : un rollup devenu
    // formule ne doit pas garder son agrégat fantôme en base.
    for (const c of ['formula_expr', 'result_type', 'lookup_fk', 'lookup_target_table', 'lookup_target_column',
      'rollup_target_table', 'rollup_target_fk', 'rollup_target_column', 'rollup_agg']) {
      updates.push(`${c}=?`); values.push(built.columns?.[c] ?? null)
    }
    for (const c of ['decimals', 'options', 'default_value']) {
      if (built.columns?.[c] !== undefined) { updates.push(`${c}=?`); values.push(built.columns[c]) }
    }
    viewDirty = true
  }

  if ('name' in (req.body || {})) {
    const n = String(req.body.name || '').trim()
    if (!n) return res.status(400).json({ error: 'Nom requis' })
    const conflict = findLabelConflict(existing.erp_table, n, { customFieldId: existing.id, fieldId: existing.column_name })
    if (conflict) return res.status(409).json({ error: labelConflictError(conflict) })
    updates.push('name=?'); values.push(n)
  }
  let retype = null
  if (!wantedKind && 'type' in (req.body || {}) && req.body.type !== existing.type) {
    if (existing.kind !== 'data') {
      return res.status(400).json({
        error: 'Le type ne se change que sur un champ de donnée — pour un champ calculé, changez sa nature (formule, lookup, rollup)',
      })
    }
    if (!DATA_TYPES.has(req.body.type)) {
      return res.status(400).json({ error: 'Type invalide' })
    }
    const toType = req.body.type
    let plan
    try { plan = planTypeConversion(existing, toType, req.body.options) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    // Avertissement OUTREPASSABLE : on refuse une première fois en disant
    // exactement ce qui serait perdu, plutôt que de vider des cellules sans
    // que personne ne l'ait demandé.
    if (plan.unconvertible > 0 && req.body.force_convert !== true) {
      return res.status(409).json({
        error: `${plan.unconvertible} valeur${plan.unconvertible > 1 ? 's' : ''} ne se convertit pas`,
        retype: {
          from: existing.type, to: toType, total: plan.total, filled: plan.filled,
          converted: plan.converted, unconvertible: plan.unconvertible, samples: plan.samples,
        },
      })
    }
    retype = plan
    updates.push('type=?'); values.push(toType)
    let optsJson
    try {
      optsJson = req.body.options != null
        ? optionsJsonFor(toType, req.body.options)
        : (plan.derivedOptions ? JSON.stringify(plan.derivedOptions) : defaultOptionsJsonFor(toType))
    } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('options=?'); values.push(optsJson)
    // Décimales : propres à nombre/devise. Si le corps en fournit, c'est le bloc
    // dédié plus bas qui les écrit (une seule assignation par colonne).
    if (!('decimals' in (req.body || {}))) {
      updates.push('decimals=?')
      values.push(toType === 'number' || toType === 'currency' ? (existing.decimals ?? 2) : null)
    }
    // La valeur par défaut suit le même chemin que les données : « Oui » sur une
    // case devient 1, un défaut intraduisible disparaît.
    const dv = convertSingleValue(existing.default_value, existing.type, existing.options, toType, optsJson)
    updates.push('default_value=?')
    values.push(dv.ok && dv.value != null && dv.value !== '' ? String(dv.value) : null)
  }
  // Description libre — éditable sur tout kind, y compris pendant une conversion.
  if ('description' in (req.body || {})) {
    let d
    try { d = normalizeDescription(req.body.description) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('description=?'); values.push(d)
  }
  if (!wantedKind && 'decimals' in (req.body || {})) {
    // Prend en compte un changement de type dans la même requête (ex: number → currency).
    const effectiveType = ('type' in (req.body || {})) ? req.body.type : existing.type
    if (effectiveType !== 'number' && effectiveType !== 'currency') return res.status(400).json({ error: 'Décimales applicable seulement aux champs nombre ou devise' })
    const d = parseInt(req.body.decimals)
    if (!Number.isInteger(d) || d < 0 || d > 5) return res.status(400).json({ error: 'Décimales doit être entre 0 et 5' })
    updates.push('decimals=?'); values.push(d)
  }
  // Les blocs qui suivent éditent un champ DANS son kind actuel : pendant une
  // conversion ils raisonneraient sur l'ancien kind (et refuseraient le corps de
  // requête du nouveau). La conversion ci-dessus a déjà posé ces colonnes.
  if (!wantedKind && 'formula_expr' in (req.body || {})) {
    if (existing.kind !== 'formula') return res.status(400).json({ error: 'formula_expr applicable seulement aux champs formule' })
    const expr = String(req.body.formula_expr || '').trim()
    try {
      validateFormulaExpr(expr)
      validateFormulaReferences(expr, existing.erp_table)
    } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('formula_expr=?'); values.push(expr)
    viewDirty = true
  }
  if (!wantedKind && ('lookup_target_column' in (req.body || {}) || 'lookup_target_table' in (req.body || {}) || 'lookup_fk' in (req.body || {}))) {
    if (existing.kind !== 'lookup') return res.status(400).json({ error: 'Champs lookup uniquement' })
    const merged = {
      lookup_fk: req.body.lookup_fk ?? existing.lookup_fk,
      lookup_target_table: req.body.lookup_target_table ?? existing.lookup_target_table,
      lookup_target_column: req.body.lookup_target_column ?? existing.lookup_target_column,
    }
    try { validateLookup(merged, existing.erp_table) } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('lookup_fk=?', 'lookup_target_table=?', 'lookup_target_column=?')
    values.push(merged.lookup_fk, merged.lookup_target_table, merged.lookup_target_column)
    viewDirty = true
  }
  if (!wantedKind && ('rollup_target_table' in (req.body || {}) || 'rollup_target_fk' in (req.body || {}) ||
      'rollup_target_column' in (req.body || {}) || 'rollup_agg' in (req.body || {}))) {
    if (existing.kind !== 'rollup') return res.status(400).json({ error: 'Champs rollup uniquement' })
    const agg = ('rollup_agg' in req.body ? req.body.rollup_agg : existing.rollup_agg)
    const merged = {
      rollup_target_table: req.body.rollup_target_table ?? existing.rollup_target_table,
      rollup_target_fk: req.body.rollup_target_fk ?? existing.rollup_target_fk,
      // Si l'agg passe à COUNT, la colonne devient facultative ; '' → null.
      rollup_target_column: ('rollup_target_column' in req.body
        ? (req.body.rollup_target_column || null)
        : existing.rollup_target_column),
      rollup_agg: agg,
    }
    try { validateRollup(merged, existing.erp_table) } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('rollup_target_table=?', 'rollup_target_fk=?', 'rollup_target_column=?', 'rollup_agg=?')
    values.push(merged.rollup_target_table, merged.rollup_target_fk, merged.rollup_target_column,
                String(merged.rollup_agg).toUpperCase())
    viewDirty = true
  }
  // result_type pilote l'affichage / le type de colonne (texte, nombre, date, URL).
  // Éditable sur les champs calculés ; notamment un rollup ARRAY/ARRAYUNIQUE
  // bascule en 'text' (liste de valeurs), un rollup numérique reste en 'number'.
  if (!wantedKind && 'result_type' in (req.body || {})) {
    if (!['formula', 'lookup', 'rollup'].includes(existing.kind)) {
      return res.status(400).json({ error: 'result_type applicable seulement aux champs formule, lookup ou rollup' })
    }
    const rt = req.body.result_type
    if (!RESULT_TYPES.includes(rt)) {
      return res.status(400).json({ error: RESULT_TYPE_ERROR })
    }
    updates.push('result_type=?'); values.push(rt)
  }

  // Édition de la config single_select (choix, couleurs, défaut, alphabétisation).
  // Les renommages migrent les valeurs déjà stockées (cf_* contient le label), de
  // sorte qu'aucune cellule ne devient orpheline. Les choix retirés conservent
  // leur valeur en base (pas de perte de donnée silencieuse).
  let cellRenames = []
  if (retype) {
    // Rien ici : le changement de type a déjà posé les options du NOUVEAU type.
    // Les branches ci-dessous raisonnent sur `existing.type` (l'ancien) et
    // écriraient une seconde fois la même colonne.
  } else if ('options' in (req.body || {}) && existing.type === 'duration') {
    // Duration : la seule option éditable est le format d'affichage.
    updates.push('options=?'); values.push(normalizeDurationOptions(req.body.options).json)
  } else if ('options' in (req.body || {}) && existing.type === 'currency') {
    // Devise : la seule option éditable est le code de devise (ISO 4217).
    let norm
    try { norm = normalizeCurrencyOptions(req.body.options) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('options=?'); values.push(norm.json)
  } else if ('options' in (req.body || {}) && existing.type === 'button') {
    // Bouton : libellé, automation cible et style.
    let norm
    try { norm = normalizeButtonOptions(req.body.options) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('options=?'); values.push(norm.json)
  } else if ('options' in (req.body || {}) && existing.type === 'phone') {
    // Téléphone : la seule option éditable est l'affichage de l'indicatif de pays.
    updates.push('options=?'); values.push(normalizePhoneOptions(req.body.options).json)
  } else if ('options' in (req.body || {}) && (existing.type === 'date' || existing.result_type === 'date')) {
    // Date (ou formula/lookup/rollup en result_type='date') : la seule option
    // éditable est le format d'affichage (ISO/local, avec ou sans heure).
    updates.push('options=?'); values.push(normalizeDateOptions(req.body.options).json)
  } else if ('options' in (req.body || {})) {
    if (existing.type !== 'single_select' && existing.type !== 'multi_select') return res.status(400).json({ error: 'options applicable seulement aux champs Sélection, Durée, Devise, Téléphone, Date ou Bouton' })
    let prevIds = new Set()
    let prevById = new Map()
    try {
      const prev = JSON.parse(existing.options || '{}')
      for (const c of (prev.choices || [])) { prevIds.add(c.id); prevById.set(c.id, c.label) }
    } catch {}
    let norm
    try { norm = normalizeSelectOptions(req.body.options, prevIds) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    for (const c of norm.obj.choices) {
      const oldLabel = prevById.get(c.id)
      if (oldLabel != null && oldLabel !== c.label) cellRenames.push({ from: oldLabel, to: c.label })
    }
    updates.push('options=?'); values.push(norm.json)
  }

  // Édition de la valeur par défaut (text/number/currency/url). Le single_select
  // gère son défaut via `options.default_id`, pas par cette colonne.
  if (!retype && 'default_value' in (req.body || {})) {
    if (existing.kind !== 'data' || existing.type === 'single_select') {
      return res.status(400).json({ error: 'Valeur par défaut applicable seulement aux champs texte, nombre, devise, URL, durée ou case à cocher' })
    }
    let dv
    try { dv = normalizeDefaultValue(req.body.default_value, existing.type) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('default_value=?'); values.push(dv)
  }

  if (updates.length === 0) return res.json(existing)
  updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  values.push(req.params.id)

  const tx = db.transaction(() => {
    // Les valeurs d'abord : si la colonne doit être refaite (affinité), elle est
    // détruite/recréée ici, et la vue régénérée dans le même mouvement.
    if (retype) {
      applyTypeConversion(existing, retype)
      if (retype.rebuild) viewDirty = false
    }
    db.prepare(`UPDATE custom_fields SET ${updates.join(', ')} WHERE id=?`).run(...values)
    // Propage les renommages de choix aux valeurs déjà saisies.
    for (const r of cellRenames) {
      if (existing.type === 'multi_select') {
        // Les cellules multi_select stockent un tableau JSON de labels. On remplace
        // le token JSON-quoté (ex: "Ancien") par le nouveau, en réutilisant
        // JSON.stringify pour échapper exactement comme à l'écriture.
        const fromTok = JSON.stringify(r.from)
        const toTok = JSON.stringify(r.to)
        db.prepare(
          `UPDATE ${existing.erp_table} SET ${existing.column_name}=REPLACE(${existing.column_name}, ?, ?) WHERE ${existing.column_name} LIKE ?`
        ).run(fromTok, toTok, `%${fromTok}%`)
      } else {
        db.prepare(`UPDATE ${existing.erp_table} SET ${existing.column_name}=? WHERE ${existing.column_name}=?`).run(r.to, r.from)
      }
    }
    if (viewDirty) {
      // Idem création : si l'édition introduit une référence cassée ou un cycle
      // touchant CE champ, on annule pour renvoyer le message précis.
      const { errors } = regenerateView(existing.erp_table)
      const myErr = errors?.find(e => e.id === req.params.id)
      if (myErr) throw new Error(myErr.message)
    }
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const updated = db.prepare(`
    SELECT id, name, column_name, type, decimals, kind, formula_expr,
           lookup_fk, lookup_target_table, lookup_target_column, result_type, sort_order,
           rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, view_error, options, default_value,
           link_target_table, link_group_id, link_role, link_single, source, airtable_mapping_id, description
    FROM custom_fields WHERE id=?
  `).get(req.params.id)
  // Bilan de conversion : le client s'en sert pour dire ce qui a été converti,
  // ce qui a été vidé, et pour afficher les choix dérivés des données.
  if (retype) {
    updated.retype = {
      from: retype.from, to: retype.to, total: retype.total, filled: retype.filled,
      converted: retype.converted, cleared: retype.unconvertible,
      rebuilt: retype.rebuild, derived_choices: retype.derivedOptions ? retype.derivedOptions.choices.length : 0,
    }
  }
  res.json(updated)
})

// DELETE /api/custom-fields/:id — soft delete.
router.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT id, erp_table, kind, link_group_id, column_name, source FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  const stamp = `UPDATE custom_fields SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
  const tx = db.transaction(() => {
    db.prepare(stamp).run(req.params.id)
    // Champ issu d'Airtable : couper aussi l'import. Sans ça, la sync continuait
    // d'écrire dans la colonne d'un champ supprimé, et la colonne réapparaissait
    // dans la page de configuration comme colonne ERP non adoptée — donnant
    // l'impression que la suppression n'avait rien fait. Les valeurs déjà
    // importées sont conservées (la corbeille des champs peut tout restaurer,
    // et le mapping se réactive en re-sélectionnant le champ Airtable).
    // Idem pour un champ CALCULÉ mappé vers Airtable (sens push seulement) : sa
    // colonne virtuelle disparaît de la vue <table>_v, le write-back n'aurait
    // plus rien à pousser — on coupe le mapping plutôt que de le laisser pendre.
    if ((existing.source === 'airtable' || PUSH_ONLY_CF_KINDS.has(existing.kind)) && existing.column_name) {
      db.prepare(
        `UPDATE airtable_field_mappings SET import_disabled=1 WHERE erp_table=? AND column_name=?`
      ).run(existing.erp_table, existing.column_name)
    }
    // Champ link : emporte aussi son champ inverse (même link_group_id) et purge
    // la jonction — sinon l'inverse pointerait vers une relation orpheline.
    if (existing.kind === 'link' && existing.link_group_id) {
      const pair = db.prepare(
        `SELECT id, erp_table FROM custom_fields WHERE link_group_id=? AND id<>? AND deleted_at IS NULL`
      ).all(existing.link_group_id, existing.id)
      for (const p of pair) {
        db.prepare(stamp).run(p.id)
      }
      deleteLinkGroup(existing.link_group_id)
      regenerateView(existing.erp_table)
      for (const p of pair) regenerateView(p.erp_table)
      return
    }
    // Pour les champs virtuels, on doit régénérer la vue pour les retirer.
    // Pour kind='data', la colonne physique reste mais n'est plus listée par
    // le GET — la corbeille admin peut la restaurer telle quelle.
    if (existing.kind && existing.kind !== 'data') {
      regenerateView(existing.erp_table)
    }
  })
  tx()
  // La colonne sort du snapshot client (voir droppedFieldColumns) : sans cette
  // invalidation, un champ kind='data' supprimé continuerait d'être envoyé
  // jusqu'au prochain redémarrage — aucune vue n'est régénérée dans ce cas.
  invalidateColumnsCache()
  res.json({ ok: true })
})

// La whitelist d'update des routes d'entité (projects, payments…) vit dans
// services/customFieldWritability.js (getWritableCustomColumns) : seuls les
// champs kind='data' ÉDITABLES selon la règle d'éditabilité unique — un champ
// Airtable en import seul est en lecture seule côté ERP.

export default router
