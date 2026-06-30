import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { regenerateView, validateFormulaExpr, validateFormulaReferences, validateLookup, validateRollup, validateLink, setLinkValue, readLinkValue, getLinkOptions, deleteLinkGroup, LINK_TARGET_WHITELIST, getLookupMeta, previewFormula, getFieldDependents, ACTIVITY_ENTITY_MAP } from '../services/customFieldsView.js'
import { parseDurationToSeconds, normalizeDurationFormat } from '../services/duration.js'
import { runRuleActionForRecord } from '../services/fieldRuleEngine.js'

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
// la route dédiée de chaque table (whitelist via getActiveCustomColumns) — déjà
// branchée pour projects ; à brancher au besoin sur les autres routes.
const ALLOWED_TABLES = new Set([
  'projects', 'factures',
  'companies', 'contacts', 'products', 'orders', 'tickets', 'tasks',
  'shipments', 'employees', 'purchases', 'achats_fournisseurs',
  'returns', 'sale_receipts', 'serial_numbers', 'interactions',
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

// GET /api/custom-fields/:id/dependents — rapport d'usage : quels AUTRES champs
// custom de la même table référencent ce champ (formules, clés étrangères de
// lookup). Consommé par la modale au moment de la suppression pour avertir qu'on
// va casser des champs calculés, plutôt que de le découvrir à l'#ERROR silencieux.
router.get('/:id/dependents', (req, res) => {
  const field = db.prepare(
    `SELECT id, erp_table, name, column_name, kind FROM custom_fields WHERE id=? AND deleted_at IS NULL`
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
router.get('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée pour les champs custom' })
  const rows = db.prepare(
    `SELECT id, name, column_name, type, decimals, sort_order,
            kind, formula_expr, lookup_fk, lookup_target_table, lookup_target_column, result_type,
            rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, view_error, options, default_value,
            link_target_table, link_group_id, link_role, link_single
     FROM custom_fields
     WHERE erp_table=? AND deleted_at IS NULL
     ORDER BY sort_order, created_at`
  ).all(erpTable)
  res.json({ data: rows })
})

// POST /api/custom-fields/:erpTable — crée un nouveau champ custom.
// Body : { name, type ('text'|'number'|'currency'|'url'), decimals (0..5) }
//
// Les types 'currency' et 'url' sont des variantes de format/rendu par-dessus le
// mécanisme 'data' existant : aucune colonne métier nouvelle.
//   - currency : nombre stocké en REAL, rendu avec format monétaire ($, séparateurs).
//                `decimals` optionnel, défaut 2.
//   - url      : texte stocké en TEXT, rendu comme lien cliquable si URL valide.
router.post('/:erpTable', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const type = req.body?.type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'currency', 'url', 'duration', 'single_select', 'multi_select', 'checkbox'].includes(type)) {
    return res.status(400).json({ error: 'Type doit être "text", "number", "currency", "url", "duration", "single_select", "multi_select" ou "checkbox"' })
  }
  // Single/multi select : valide/normalise la config des choix (libellés,
  // couleurs, défaut, alphabétisation) avant de créer la colonne. Le multi_select
  // stocke un tableau JSON de labels ; le single_select un label scalaire.
  // Duration : la config (format d'affichage) tient aussi dans `options`.
  let optionsJson = null
  if (type === 'single_select' || type === 'multi_select') {
    try { optionsJson = normalizeSelectOptions(req.body?.options).json }
    catch (e) { return res.status(400).json({ error: e.message }) }
  } else if (type === 'duration') {
    optionsJson = normalizeDurationOptions(req.body?.options).json
  }
  let decimals = null
  if (type === 'number' || type === 'currency') {
    // Currency : décimales facultatives, défaut 2 (format monétaire usuel).
    // Number : décimales requises (comportement historique).
    const raw = req.body?.decimals
    if ((raw === undefined || raw === null || raw === '') && type === 'currency') {
      decimals = 2
    } else {
      decimals = parseInt(raw)
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 5) {
      return res.status(400).json({ error: 'Décimales doit être entre 0 et 5' })
    }
  }

  // Valeur par défaut (text/number/currency/url/duration/checkbox uniquement — le
  // single_select porte son défaut dans options.default_id). number/currency :
  // doit être un nombre fini ; duration : une durée parseable ; checkbox : 1 si
  // coché par défaut, sinon NULL. Vide → NULL.
  let defaultValue = null
  if (['text', 'number', 'currency', 'url', 'duration', 'checkbox'].includes(type)) {
    try { defaultValue = normalizeDefaultValue(req.body?.default_value, type) }
    catch (e) { return res.status(400).json({ error: e.message }) }
  }

  const slug = slugify(name)
  const columnName = ensureUniqueColumnName(erpTable, slug)
  // SQLite : pas de type strict. number/currency/duration → REAL (duration en
  // secondes) ; checkbox → INTEGER (0/1) ; text/url/single_select → TEXT
  // (single_select stocke le label).
  const sqlType = (type === 'number' || type === 'currency' || type === 'duration')
    ? 'REAL'
    : (type === 'checkbox' ? 'INTEGER' : 'TEXT')

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE ${erpTable} ADD COLUMN ${columnName} ${sqlType}`)
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, decimals, sort_order, options, default_value)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, type, decimals, sortOrder, optionsJson, defaultValue)
  })
  tx()

  const created = db.prepare(`SELECT id, name, column_name, type, decimals, sort_order, options, default_value FROM custom_fields WHERE id=?`).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/formula — crée un champ calculé
// (expression SQLite, exposée uniquement via la VUE <table>_v).
// Body : { name, formula_expr, result_type ('text'|'number'|'date') }
router.post('/:erpTable/formula', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const formulaExpr = String(req.body?.formula_expr || '').trim()
  const resultType = req.body?.result_type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'date'].includes(resultType)) {
    return res.status(400).json({ error: "result_type doit être 'text', 'number' ou 'date'" })
  }
  try {
    validateFormulaExpr(formulaExpr)
    // Rejette dès la création une formule référençant une colonne inexistante,
    // plutôt que de créer un champ qui afficherait #ERROR.
    validateFormulaReferences(formulaExpr, erpTable)
  } catch (e) { return res.status(400).json({ error: e.message }) }

  const slug = slugify(name)
  // Pour les champs virtuels (kind formula/lookup), pas de colonne physique :
  // on doit juste éviter une collision avec les noms de colonnes de la table
  // ou un autre custom_field actif.
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, formula_expr, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, resultType === 'number' ? 'number' : 'text', 'formula', formulaExpr, resultType, sortOrder)
    // La régénération résout les dépendances entre champs custom et détecte les
    // cycles. Si CE champ se retrouve en erreur (référence introuvable ou cycle),
    // on annule la création — l'utilisateur reçoit le message précis plutôt qu'un
    // champ qui afficherait #ERROR dès sa naissance.
    const { errors } = regenerateView(erpTable)
    const myErr = errors?.find(e => e.id === id)
    if (myErr) throw new Error(myErr.message)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, formula_expr, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
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

// POST /api/custom-fields/:erpTable/lookup — crée un champ lookup
// (LEFT JOIN dans la VUE).
// Body : { name, lookup_fk, lookup_target_table, lookup_target_column, result_type }
router.post('/:erpTable/lookup', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const lookup = {
    lookup_fk: req.body?.lookup_fk,
    lookup_target_table: req.body?.lookup_target_table,
    lookup_target_column: req.body?.lookup_target_column,
  }
  const resultType = req.body?.result_type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'date'].includes(resultType)) {
    return res.status(400).json({ error: "result_type doit être 'text', 'number' ou 'date'" })
  }
  try { validateLookup(lookup, erpTable) } catch (e) { return res.status(400).json({ error: e.message }) }

  const slug = slugify(name)
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind,
        lookup_fk, lookup_target_table, lookup_target_column, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, resultType === 'number' ? 'number' : 'text', 'lookup',
           lookup.lookup_fk, lookup.lookup_target_table, lookup.lookup_target_column, resultType, sortOrder)
    regenerateView(erpTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, lookup_fk, lookup_target_table,
           lookup_target_column, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/rollup — crée un champ rollup : agrège une
// colonne d'une table ENFANT qui référence la table source via une FK inverse
// (ex: projects ← orders.project_id → SUM(orders.total)). Exposé via une
// sous-requête corrélée dans la VUE <table>_v.
// Body : { name, rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, result_type }
router.post('/:erpTable/rollup', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const rollup = {
    rollup_target_table: req.body?.rollup_target_table,
    rollup_target_fk: req.body?.rollup_target_fk,
    // COUNT n'a pas besoin de colonne — on normalise '' → null.
    rollup_target_column: req.body?.rollup_target_column || null,
    rollup_agg: req.body?.rollup_agg,
  }
  // result_type pilote l'affichage. Défaut 'number' (les agrégats sont numériques).
  const resultType = req.body?.result_type || 'number'
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!['text', 'number', 'date'].includes(resultType)) {
    return res.status(400).json({ error: "result_type doit être 'text', 'number' ou 'date'" })
  }
  try { validateRollup(rollup, erpTable) } catch (e) { return res.status(400).json({ error: e.message }) }

  const slug = slugify(name)
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind,
        rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, resultType === 'number' ? 'number' : 'text', 'rollup',
           rollup.rollup_target_table, rollup.rollup_target_fk, rollup.rollup_target_column,
           String(rollup.rollup_agg).toUpperCase(), resultType, sortOrder)
    regenerateView(erpTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, rollup_target_table, rollup_target_fk,
           rollup_target_column, rollup_agg, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/auto — crée un champ auto-rempli (lecture
// seule), exposé uniquement via la VUE <table>_v. Parité Airtable :
//   - created_time       : date de création (colonne created_at)
//   - last_modified_time : date de dernière modification (colonne updated_at)
//   - created_by         : utilisateur ayant créé l'enregistrement (activity_log)
//   - last_modified_by   : dernier utilisateur ayant modifié (activity_log)
// Body : { name, auto_type }
const AUTO_TYPES = {
  created_time:       { result_type: 'date', needsCreatedAt: true },
  last_modified_time: { result_type: 'date', needsUpdatedAt: true },
  created_by:         { result_type: 'text', needsEntity: true },
  last_modified_by:   { result_type: 'text', needsEntity: true },
}

router.post('/:erpTable/auto', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const autoType = req.body?.auto_type
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  const spec = AUTO_TYPES[autoType]
  if (!spec) {
    return res.status(400).json({ error: "auto_type doit être 'created_time', 'last_modified_time', 'created_by' ou 'last_modified_by'" })
  }
  // created_time : la table doit posséder une colonne created_at.
  if (spec.needsCreatedAt) {
    const cols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
    if (!cols.includes('created_at')) {
      return res.status(400).json({ error: `Table ${erpTable} sans colonne created_at — type non supporté` })
    }
  }
  // last_modified_time : la table doit posséder une colonne updated_at.
  if (spec.needsUpdatedAt) {
    const cols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
    if (!cols.includes('updated_at')) {
      return res.status(400).json({ error: `Table ${erpTable} sans colonne updated_at — type non supporté` })
    }
  }
  // created_by / last_modified_by : un mapping activity_log doit exister.
  if (spec.needsEntity && !ACTIVITY_ENTITY_MAP[erpTable]) {
    return res.status(400).json({ error: `Attribution (activity_log) non disponible pour ${erpTable}` })
  }

  const slug = slugify(name)
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)

  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, result_type, sort_order)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, erpTable, name, columnName, 'text', autoType, spec.result_type, sortOrder)
    regenerateView(erpTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, result_type, sort_order
    FROM custom_fields WHERE id=?
  `).get(id)
  res.status(201).json(created)
})

// POST /api/custom-fields/:erpTable/button — crée un champ « Bouton » (à la
// Airtable) qui déclenche une automation (field_rule) sur le record de la ligne
// au clic. Pas de colonne physique ni de contribution à la VUE : c'est une
// action, pas une valeur (regenerateView ignore kind='button'). La config tient
// dans options : { label, automation_id, style }.
router.post('/:erpTable/button', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  let optionsJson
  try { optionsJson = normalizeButtonOptions(req.body?.options).json }
  catch (e) { return res.status(400).json({ error: e.message }) }

  // Identité virtuelle (pas de colonne physique) — réutilise le namespace des
  // champs virtuels pour éviter toute collision de column_name.
  const slug = slugify(name)
  const columnName = ensureUniqueVirtualColumnName(erpTable, slug)
  const id = uuid()
  const lastSortRow = db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(erpTable)
  const sortOrder = (lastSortRow?.m ?? -1) + 1

  db.prepare(`
    INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, options, sort_order)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, erpTable, name, columnName, 'button', 'button', optionsJson, sortOrder)

  const created = db.prepare(
    `SELECT id, name, column_name, type, kind, options, sort_order FROM custom_fields WHERE id=?`
  ).get(id)
  res.status(201).json(created)
})

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

// POST /api/custom-fields/:erpTable/link — crée un champ de LIAISON bidirectionnel
// (à la Airtable) entre erpTable et une table cible, et crée AUTOMATIQUEMENT le
// champ inverse sur la cible (sauf create_inverse=false). Les deux champs
// partagent un link_group_id : la table de jonction custom_field_links est la
// seule source de vérité, donc les deux côtés restent synchronisés.
// Body : { name, link_target_table, relationship, create_inverse?, inverse_name? }
router.post('/:erpTable/link', (req, res) => {
  const { erpTable } = req.params
  if (!ALLOWED_TABLES.has(erpTable)) return res.status(400).json({ error: 'Table non supportée' })
  const name = String(req.body?.name || '').trim()
  const targetTable = String(req.body?.link_target_table || '').trim()
  const relationship = req.body?.relationship || 'one_to_many'
  const createInverse = req.body?.create_inverse !== false
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  if (!LINK_RELATIONSHIPS[relationship]) {
    return res.status(400).json({ error: "relationship doit être 'one_to_one', 'one_to_many' ou 'many_to_many'" })
  }
  if (!ALLOWED_TABLES.has(targetTable) || !LINK_TARGET_WHITELIST.has(targetTable)) {
    return res.status(400).json({ error: 'Table cible non autorisée pour une liaison' })
  }
  if (targetTable === erpTable) {
    return res.status(400).json({ error: 'Auto-liaison (même table) non supportée' })
  }
  try { validateLink({ link_target_table: targetTable }, erpTable) }
  catch (e) { return res.status(400).json({ error: e.message }) }

  const card = LINK_RELATIONSHIPS[relationship]
  const groupId = uuid()
  const sourceId = uuid()
  const inverseId = createInverse ? uuid() : null
  const sourceCol = ensureUniqueVirtualColumnName(erpTable, slugify(name))
  // Nom du champ inverse : par défaut, le nom de la table source (capitalisé).
  const inverseName = String(req.body?.inverse_name || '').trim() || erpTable
  const inverseCol = createInverse ? ensureUniqueVirtualColumnName(targetTable, slugify(inverseName)) : null

  const nextSort = (t) => (db.prepare(
    `SELECT MAX(sort_order) AS m FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL`
  ).get(t)?.m ?? -1) + 1

  const insert = db.prepare(`
    INSERT INTO custom_fields
      (id, erp_table, name, column_name, type, kind, result_type, sort_order,
       link_target_table, link_group_id, link_role, link_single)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  const tx = db.transaction(() => {
    insert.run(sourceId, erpTable, name, sourceCol, 'link', 'link', 'text', nextSort(erpTable),
               targetTable, groupId, 'source', card.source_single)
    if (createInverse) {
      insert.run(inverseId, targetTable, inverseName, inverseCol, 'link', 'link', 'text', nextSort(targetTable),
                 erpTable, groupId, 'target', card.inverse_single)
    }
    regenerateView(erpTable)
    if (createInverse) regenerateView(targetTable)
  })
  try { tx() } catch (e) { return res.status(400).json({ error: e.message }) }

  const created = db.prepare(`
    SELECT id, name, column_name, type, kind, result_type, sort_order,
           link_target_table, link_group_id, link_role, link_single
    FROM custom_fields WHERE id=?
  `).get(sourceId)
  res.status(201).json(created)
})

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

// PUT /api/custom-fields/:id — modifie nom, décimales, et (selon le kind)
// l'expression formule ou la config lookup. Le `column_name`, le `type`, et
// le `kind` ne peuvent pas changer.
router.put('/:id', (req, res) => {
  const existing = db.prepare(`SELECT * FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  if (existing.deleted_at) return res.status(400).json({ error: 'Champ supprimé — restaurer d\'abord depuis la corbeille' })

  const updates = []
  const values = []
  let viewDirty = false

  if ('name' in (req.body || {})) {
    const n = String(req.body.name || '').trim()
    if (!n) return res.status(400).json({ error: 'Nom requis' })
    updates.push('name=?'); values.push(n)
  }
  if ('decimals' in (req.body || {})) {
    if (existing.type !== 'number' && existing.type !== 'currency') return res.status(400).json({ error: 'Décimales applicable seulement aux champs nombre ou devise' })
    const d = parseInt(req.body.decimals)
    if (!Number.isInteger(d) || d < 0 || d > 5) return res.status(400).json({ error: 'Décimales doit être entre 0 et 5' })
    updates.push('decimals=?'); values.push(d)
  }
  if ('formula_expr' in (req.body || {})) {
    if (existing.kind !== 'formula') return res.status(400).json({ error: 'formula_expr applicable seulement aux champs formule' })
    const expr = String(req.body.formula_expr || '').trim()
    try {
      validateFormulaExpr(expr)
      validateFormulaReferences(expr, existing.erp_table)
    } catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('formula_expr=?'); values.push(expr)
    viewDirty = true
  }
  if ('lookup_target_column' in (req.body || {}) || 'lookup_target_table' in (req.body || {}) || 'lookup_fk' in (req.body || {})) {
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
  if ('rollup_target_table' in (req.body || {}) || 'rollup_target_fk' in (req.body || {}) ||
      'rollup_target_column' in (req.body || {}) || 'rollup_agg' in (req.body || {})) {
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

  // Édition de la config single_select (choix, couleurs, défaut, alphabétisation).
  // Les renommages migrent les valeurs déjà stockées (cf_* contient le label), de
  // sorte qu'aucune cellule ne devient orpheline. Les choix retirés conservent
  // leur valeur en base (pas de perte de donnée silencieuse).
  let cellRenames = []
  if ('options' in (req.body || {}) && existing.type === 'duration') {
    // Duration : la seule option éditable est le format d'affichage.
    updates.push('options=?'); values.push(normalizeDurationOptions(req.body.options).json)
  } else if ('options' in (req.body || {}) && existing.type === 'button') {
    // Bouton : libellé, automation cible et style.
    let norm
    try { norm = normalizeButtonOptions(req.body.options) }
    catch (e) { return res.status(400).json({ error: e.message }) }
    updates.push('options=?'); values.push(norm.json)
  } else if ('options' in (req.body || {})) {
    if (existing.type !== 'single_select' && existing.type !== 'multi_select') return res.status(400).json({ error: 'options applicable seulement aux champs Sélection ou Durée' })
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
  if ('default_value' in (req.body || {})) {
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
           link_target_table, link_group_id, link_role, link_single
    FROM custom_fields WHERE id=?
  `).get(req.params.id)
  res.json(updated)
})

// DELETE /api/custom-fields/:id — soft delete.
router.delete('/:id', (req, res) => {
  const existing = db.prepare(`SELECT id, erp_table, kind, link_group_id FROM custom_fields WHERE id=?`).get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Champ introuvable' })
  const stamp = `UPDATE custom_fields SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`
  const tx = db.transaction(() => {
    db.prepare(stamp).run(req.params.id)
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
  res.json({ ok: true })
})

// GET /api/custom-fields/all/columns/:erpTable — utilitaire interne :
// retourne juste les noms de colonnes actives (pour whitelist update côté
// routes/projects par ex). Non exposé au client.
export function getActiveCustomColumns(erpTable) {
  // Seuls les champs kind='data' ont une colonne physique inscriptible. Les
  // champs virtuels (formula/lookup/auto) vivent dans la VUE et sont en lecture
  // seule — les exposer en whitelist d'UPDATE casserait le PATCH (colonne
  // inexistante sur la table physique).
  return db.prepare(
    `SELECT column_name, type, decimals FROM custom_fields WHERE erp_table=? AND deleted_at IS NULL AND kind='data'`
  ).all(erpTable)
}

export default router
