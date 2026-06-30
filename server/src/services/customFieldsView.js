// Génère / régénère la VUE SQLite `<table>_v` qui expose, en plus des colonnes
// physiques de `<table>` :
//   - les champs custom de kind='formula' calculés à la lecture via une
//     expression SQLite stockée dans custom_fields.formula_expr
//   - les champs custom de kind='lookup' obtenus par LEFT JOIN sur la table
//     liée via la colonne FK locale
//
// Pourquoi une vue plutôt que des colonnes générées : les GENERATED de SQLite
// ne peuvent pas faire de JOIN, donc impossible d'exprimer un lookup en pur
// SQL. La vue règle ce problème sans coût de matérialisation tant que les
// volumes restent modérés (~100k lignes max). Si une formule devient assez
// load-bearing pour nécessiter d'être indexée, elle peut être promue en
// `kind='data'` + trigger de maintenance.
//
// V2 — résolution de dépendances entre champs custom :
//   - une formule PEUT désormais référencer d'autres champs custom de la même
//     table (formule, lookup, rollup, champ auto). La vue n'est plus un SELECT
//     plat unique : elle est construite en COUCHES imbriquées (sous-requêtes)
//     ordonnées par profondeur de dépendance. La couche 0 expose les colonnes
//     physiques + les champs custom qui ne dépendent que d'elles (lookups,
//     rollups, autos, formules sans référence croisée) ; chaque couche
//     supérieure ajoute les formules dont toutes les dépendances sont déjà
//     calculées dans une couche inférieure — où elles apparaissent comme de
//     vraies colonnes que SQLite sait résoudre.
//   - les cycles entre formules (A→B→A, ou auto-référence) sont détectés par un
//     parcours DFS ; les champs impliqués sont dégradés en NULL avec un
//     view_error explicite (« Référence circulaire… ») plutôt que de boucler.
//   - une seule colonne par lookup (pour faire 2 colonnes du même record lié,
//     créer 2 lookups distincts — le query planner consolidera les JOIN)

import { v4 as uuid } from 'uuid'
import db from '../db/database.js'

// Whitelist des tables qu'on autorise comme cible de lookup. Exclut
// volontairement `users` (hashes de mots de passe), `oauth_tokens`,
// `automation_secrets`, etc.
export const LOOKUP_TARGET_WHITELIST = new Set([
  'companies', 'contacts', 'projects', 'orders', 'products', 'employees',
  'subscriptions', 'shipments', 'returns', 'tasks', 'factures', 'soumissions',
  'achats_fournisseurs', 'addresses', 'activity_codes',
])

// Tables autorisées comme CIBLE d'un champ link bidirectionnel. Doit rester
// alignée sur ALLOWED_TABLES (routes/custom-fields.js) : la cible reçoit un champ
// inverse auto-créé, donc elle doit elle-même supporter les champs custom et la
// VUE <table>_v.
export const LINK_TARGET_WHITELIST = new Set([
  'projects', 'factures', 'companies', 'contacts', 'products', 'orders',
  'tickets', 'tasks', 'shipments', 'employees', 'purchases',
  'achats_fournisseurs', 'returns', 'sale_receipts', 'serial_numbers', 'interactions',
])

// Colonnes qu'on n'expose JAMAIS en lookup (secrets, hashes, tokens).
// La whitelist de tables protège déjà les tables sensibles, mais cette
// blocklist sert de second rideau pour les colonnes ad-hoc qu'une table
// autorisée pourrait acquérir plus tard.
const SENSITIVE_COLUMN_PATTERNS = [
  /password/i, /secret/i, /token/i, /api_key/i, /encrypted/i, /_hash$/i,
]

function isSafeLookupColumn(name) {
  return !SENSITIVE_COLUMN_PATTERNS.some(re => re.test(name))
}

// Colonne « libellé » lisible d'une table (pour afficher un record lié). Premier
// candidat existant, sinon 'id'. Partagé par les champs link (jonction → label)
// et l'aperçu de formule.
export function labelColumnFor(table) {
  if (!SAFE_IDENT.test(table)) throw new Error('Nom de table invalide')
  const cols = db.pragma(`table_info(${table})`).map(c => c.name)
  return ['name', 'document_number', 'title', 'invoice_number', 'number', 'label', 'email', 'id']
    .find(c => cols.includes(c)) || 'id'
}

// Mapping erp_table → entity_type d'activity_log, pour les champs auto-remplis
// created_by / last_modified_by. Doit matcher HISTORY_ENTITY_MAP (routes/records.js)
// et l'`entity` émis par emitEntity/emitOrder/emitCompany (realtimeEmitters.js) —
// sinon la sous-requête activity_log ne joindra jamais aucune ligne.
export const ACTIVITY_ENTITY_MAP = {
  projects: 'project',
  factures: 'facture',
  companies: 'company',
  contacts: 'contact',
  orders: 'order',
  products: 'product',
  tickets: 'ticket',
  tasks: 'task',
  shipments: 'shipment',
  employees: 'employee',
  purchases: 'purchase',
  achats_fournisseurs: 'achat_fournisseur',
  interactions: 'interaction',
}

// Kinds de champs auto-remplis : lecture seule, calculés à la lecture via la VUE.
//   - created_time       : reprend la colonne physique created_at de la table
//   - last_modified_time : reprend la colonne physique updated_at de la table
//   - created_by         : nom de l'utilisateur du 1er event 'created' d'activity_log
//   - last_modified_by   : nom de l'utilisateur du dernier event d'activity_log
export const AUTO_KINDS = new Set(['created_time', 'last_modified_time', 'created_by', 'last_modified_by'])

// Fonctions d'agrégation autorisées pour les rollups.
export const ROLLUP_AGGS = new Set(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'])

// Candidats de "singulier" pour dériver le nom de colonne FK inverse probable
// d'une table source (projects → project, factures → facture, companies → company).
function singularCandidates(table) {
  const out = new Set()
  if (table.endsWith('ies')) out.add(table.slice(0, -3) + 'y')
  if (table.endsWith('ses')) out.add(table.slice(0, -2))
  if (table.endsWith('es')) out.add(table.slice(0, -2))
  if (table.endsWith('s')) out.add(table.slice(0, -1))
  out.add(table)
  return [...out]
}

// Métadonnées exposées au client pour construire l'UI de création de lookup.
// Retourne pour la table source : les colonnes FK détectées (via PRAGMA
// foreign_key_list) avec leur table cible probable, plus la whitelist de
// tables autorisées et leurs colonnes disponibles.
export function getLookupMeta(erpTable) {
  if (!SAFE_IDENT.test(erpTable)) throw new Error('Nom de table invalide')
  const fks = db.pragma(`foreign_key_list(${erpTable})`)
  const fkColumns = fks
    .filter(fk => LOOKUP_TARGET_WHITELIST.has(fk.table))
    .map(fk => ({ column: fk.from, target_table: fk.table }))
  // Aussi : exposer les colonnes qui *ressemblent* à une FK (suffixe _id) même
  // si elles n'ont pas de contrainte FK formelle — utile pour les liens
  // textuels (customer_id Stripe, etc.).
  const allCols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
  for (const col of allCols) {
    if (col.endsWith('_id') && !fkColumns.find(f => f.column === col)) {
      // Heuristique : nom de la table cible = pluriel du préfixe (company_id → companies, contact_id → contacts).
      const base = col.slice(0, -3)
      const guesses = [base + 's', base + 'es', base]
      const target = guesses.find(g => LOOKUP_TARGET_WHITELIST.has(g))
      if (target) fkColumns.push({ column: col, target_table: target, inferred: true })
    }
  }

  const targetColumns = {}
  for (const t of LOOKUP_TARGET_WHITELIST) {
    try {
      const cols = db.pragma(`table_info(${t})`).map(c => c.name).filter(isSafeLookupColumn)
      if (cols.length > 0) targetColumns[t] = cols
    } catch {}
  }

  // Rollup : tables ENFANT (dans la whitelist) qui référencent erpTable via une
  // FK inverse. Détection par contrainte FK formelle, sinon par heuristique de
  // nom (<singulier(erpTable)>_id). On expose chaque (table enfant, colonne FK).
  const singulars = singularCandidates(erpTable)
  const inferredFkNames = new Set(singulars.map(s => `${s}_id`))
  const rollupSources = []
  for (const t of LOOKUP_TARGET_WHITELIST) {
    if (t === erpTable) continue
    let cols
    try { cols = db.pragma(`table_info(${t})`).map(c => c.name) } catch { continue }
    const seen = new Set()
    // 1) FK formelle pointant vers erpTable
    try {
      for (const fk of db.pragma(`foreign_key_list(${t})`)) {
        if (fk.table === erpTable && cols.includes(fk.from) && !seen.has(fk.from)) {
          seen.add(fk.from)
          rollupSources.push({ table: t, fk_column: fk.from })
        }
      }
    } catch {}
    // 2) Heuristique de nom (<singulier>_id)
    for (const c of cols) {
      if (inferredFkNames.has(c) && !seen.has(c)) {
        seen.add(c)
        rollupSources.push({ table: t, fk_column: c, inferred: true })
      }
    }
  }

  // Champs auto-remplis réellement disponibles pour cette table : created_time
  // nécessite une colonne created_at ; last_modified_time une colonne updated_at ;
  // created_by / last_modified_by nécessitent un mapping activity_log. La modale
  // s'en sert pour masquer les sous-types non supportés (ex: une table sans
  // historique n'offre pas « Créé par »).
  const supportedAutoTypes = []
  if (allCols.includes('created_at')) supportedAutoTypes.push('created_time')
  if (allCols.includes('updated_at')) supportedAutoTypes.push('last_modified_time')
  if (ACTIVITY_ENTITY_MAP[erpTable]) supportedAutoTypes.push('created_by', 'last_modified_by')

  // Champs link : tables cibles autorisées (avec un libellé lisible), hors la
  // table source elle-même (auto-lien non géré pour l'instant).
  const linkTargets = [...LINK_TARGET_WHITELIST]
    .filter(t => t !== erpTable)
    .map(t => {
      try { return { table: t, label_column: labelColumnFor(t) } }
      catch { return null }
    })
    .filter(Boolean)

  return {
    fk_columns: fkColumns,
    allowed_targets: [...LOOKUP_TARGET_WHITELIST],
    target_columns: targetColumns,
    rollup_sources: rollupSources,
    supported_auto_types: supportedAutoTypes,
    link_targets: linkTargets,
    // Colonnes de la table source elle-même — alimente l'autocomplete de
    // l'éditeur de formule (à la Airtable). On filtre les colonnes sensibles
    // par cohérence, même si projects/factures n'en exposent pas. On y ajoute
    // les AUTRES champs custom virtuels (formule/lookup/rollup/auto) de la même
    // table : une formule peut désormais les référencer (résolution de
    // dépendances V2), donc l'éditeur doit pouvoir les suggérer.
    source_columns: [...new Set([
      ...allCols.filter(isSafeLookupColumn),
      ...db.prepare(
        `SELECT column_name FROM custom_fields
         WHERE erp_table=? AND deleted_at IS NULL
           AND kind IN ('formula','lookup','rollup','link','created_time','last_modified_time','created_by','last_modified_by')`
      ).all(erpTable).map(r => r.column_name),
    ])],
  }
}

// Évalue une expression formule (lecture seule) sur N vrais records de la table
// source et retourne, pour chacun, un label lisible + la valeur calculée. Sert
// au bouton « Tester » de l'éditeur de formule : l'auteur voit le résultat réel
// avant de sauvegarder, sans rien persister.
//
// Sécurité : validateFormulaExpr rejette les tokens dangereux (SELECT, ;, --,
// etc.), donc l'expression ne peut être qu'une expression scalaire en lecture.
// Le SELECT enveloppe est lui-même read-only. erpTable est validé SAFE_IDENT et
// vient d'une whitelist côté route.
// Relation à utiliser pour valider/prévisualiser une formule. On préfère la VUE
// <table>_v si elle existe : elle expose les AUTRES champs custom de la table,
// donc une formule peut en référencer un (résolution de dépendances V2). Si la
// table n'a encore aucun champ virtuel (la vue n'existe pas), on retombe sur la
// table physique — la formule ne peut alors référencer que des colonnes
// physiques, ce qui est correct.
function formulaReadRelation(erpTable) {
  const v = `${erpTable}_v`
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?").get(v)
  return exists ? v : erpTable
}

export function previewFormula(erpTable, formulaExpr, limit = 5) {
  if (!SAFE_IDENT.test(erpTable)) throw new Error('Nom de table invalide')
  validateFormulaExpr(formulaExpr)
  const rel = formulaReadRelation(erpTable)
  const cols = db.pragma(`table_info(${rel})`).map(c => c.name)
  if (!cols.includes('id')) throw new Error(`Table ${erpTable} sans colonne id — aperçu non supporté`)
  const n = Math.max(1, Math.min(20, parseInt(limit) || 5))
  // Toutes les tables n'ont pas deleted_at (ex: factures) — ne filtrer que si présent.
  const where = cols.includes('deleted_at') ? 'WHERE deleted_at IS NULL' : ''
  // Label lisible par enregistrement : premier candidat existant.
  const labelCol = ['name', 'document_number', 'title', 'invoice_number', 'number', 'id']
    .find(c => cols.includes(c)) || 'id'
  // Une VUE n'a pas de rowid — on trie sur created_at si disponible, sinon id.
  const orderCol = cols.includes('created_at') ? 'created_at' : 'id'
  let rows
  try {
    rows = db.prepare(
      `SELECT id AS _id, ${labelCol} AS _label, (${formulaExpr}) AS _value ` +
      `FROM ${rel} ${where} ORDER BY ${orderCol} DESC LIMIT ${n}`
    ).all()
  } catch (e) {
    const m = /no such column:\s*(\S+)/i.exec(e.message || '')
    if (m) throw new Error(`Colonne référencée introuvable : « ${m[1]} »`)
    throw new Error(`Expression invalide : ${e.message}`)
  }
  return rows.map(r => ({ id: r._id, label: r._label, value: r._value }))
}

// Tokens interdits dans formula_expr — pour bloquer toute évasion vers une
// modification d'état ou une lecture hors table source. SQLite catche le reste
// via parse-error au CREATE VIEW.
const FORBIDDEN_TOKENS = /\b(select|insert|update|delete|attach|detach|pragma|alter|drop|create|reindex|vacuum|exec|execute|begin|commit|rollback|savepoint)\b|;|--|\/\*|\*\//i

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function validateFormulaExpr(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error('Expression vide')
  }
  if (expr.length > 1000) {
    throw new Error('Expression trop longue (max 1000 caractères)')
  }
  if (FORBIDDEN_TOKENS.test(expr)) {
    throw new Error('Expression contient un mot-clé interdit (SELECT, ;, etc.)')
  }
}

// Valide que toutes les colonnes référencées par une formule existent réellement
// sur la table source — sinon la formule créerait une VUE cassée silencieusement.
// On laisse SQLite faire l'autorité : on compile (sans exécuter) un SELECT de
// l'expression et on reformule l'éventuelle erreur « no such column » en message
// lisible. À appeler APRÈS validateFormulaExpr (qui garantit l'absence de tokens
// interdits, donc d'injection). erpTable doit déjà être un identifiant validé.
export function validateFormulaReferences(formulaExpr, erpTable) {
  if (!SAFE_IDENT.test(erpTable)) throw new Error('Nom de table invalide')
  // On sonde contre la VUE (si elle existe) pour autoriser les références à
  // d'autres champs custom. Note : ce contrôle ne détecte PAS les cycles — un
  // champ édité référençant un champ qui le référence en retour passe ici (les
  // deux colonnes existent), le cycle n'apparaissant qu'à la régénération de la
  // vue. La détection de cycle se fait dans regenerateView (DFS) et l'appelant
  // (route) annule la transaction si le champ sauvegardé se retrouve en erreur.
  const rel = formulaReadRelation(erpTable)
  try {
    db.prepare(`SELECT (${formulaExpr}) AS _probe FROM ${rel} LIMIT 0`)
  } catch (e) {
    const m = /no such column:\s*(\S+)/i.exec(e.message || '')
    if (m) throw new Error(`Colonne référencée introuvable : « ${m[1]} »`)
    throw new Error(`Expression invalide : ${e.message}`)
  }
}

// Construit l'expression SELECT (et les éventuels JOIN) d'une colonne virtuelle.
// `alias` est un compteur mutable { n } partagé pour générer des alias de JOIN
// uniques. Lève une erreur de configuration (token interdit, table non
// whitelistée, colonne cible absente…) — l'appelant décide s'il rejette ou
// dégrade. column_name est supposé déjà validé SAFE_IDENT par l'appelant.
function buildVirtualColumn(cf, erpTable, alias) {
  if (cf.kind === 'formula') {
    validateFormulaExpr(cf.formula_expr)
    return { selectExpr: `(${cf.formula_expr}) AS ${cf.column_name}`, joins: [] }
  }
  if (cf.kind === 'lookup') {
    validateLookup(cf, erpTable)
    const a = `_j${++alias.n}`
    return {
      selectExpr: `${a}.${cf.lookup_target_column} AS ${cf.column_name}`,
      joins: [`LEFT JOIN ${cf.lookup_target_table} AS ${a} ON ${a}.id = ${erpTable}.${cf.lookup_fk}`],
    }
  }
  if (cf.kind === 'rollup') {
    validateRollup(cf, erpTable)
    const agg = String(cf.rollup_agg).toUpperCase()
    const ralias = `_r${++alias.n}`
    const childCols = db.pragma(`table_info(${cf.rollup_target_table})`).map(c => c.name)
    const softFilter = childCols.includes('deleted_at') ? ` AND ${ralias}.deleted_at IS NULL` : ''
    const inner = agg === 'COUNT' ? 'COUNT(*)' : `${agg}(${ralias}.${cf.rollup_target_column})`
    const wrapped = (agg === 'COUNT' || agg === 'SUM') ? `coalesce(${inner}, 0)` : inner
    return {
      selectExpr:
        `(SELECT ${wrapped} FROM ${cf.rollup_target_table} AS ${ralias} ` +
        `WHERE ${ralias}.${cf.rollup_target_fk} = ${erpTable}.id${softFilter}) AS ${cf.column_name}`,
      joins: [],
    }
  }
  if (cf.kind === 'link') {
    validateLink(cf, erpTable)
    // link_group_id est généré server-side (uuid) ; on le valide tout de même
    // car il est interpolé en littéral SQL.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cf.link_group_id || '')) throw new Error('link_group_id invalide')
    // CE record occupe la colonne `mine` de la jonction ; les records liés sont
    // dans `other`. On émet un tableau JSON [{id,label}, …] des records liés
    // (non supprimés). coalesce('[]') garantit un tableau même sans lien.
    const mine = cf.link_role === 'target' ? 'target_id' : 'source_id'
    const other = cf.link_role === 'target' ? 'source_id' : 'target_id'
    const tgt = cf.link_target_table
    const labelCol = labelColumnFor(tgt)
    const a = `_l${++alias.n}`
    const tgtCols = db.pragma(`table_info(${tgt})`).map(c => c.name)
    const softFilter = tgtCols.includes('deleted_at') ? ` AND ${a}.deleted_at IS NULL` : ''
    return {
      selectExpr:
        `coalesce((SELECT json_group_array(json_object('id', ${a}.id, 'label', ${a}.${labelCol})) ` +
        `FROM custom_field_links _j JOIN ${tgt} ${a} ON ${a}.id = _j.${other} ` +
        `WHERE _j.link_group_id = '${cf.link_group_id}' AND _j.${mine} = ${erpTable}.id${softFilter}), '[]') ` +
        `AS ${cf.column_name}`,
      joins: [],
    }
  }
  if (cf.kind === 'created_time') {
    return { selectExpr: `${erpTable}.created_at AS ${cf.column_name}`, joins: [] }
  }
  if (cf.kind === 'last_modified_time') {
    return { selectExpr: `${erpTable}.updated_at AS ${cf.column_name}`, joins: [] }
  }
  if (cf.kind === 'created_by' || cf.kind === 'last_modified_by') {
    const entity = ACTIVITY_ENTITY_MAP[erpTable]
    if (!entity) throw new Error(`Pas de mapping activity_log pour la table "${erpTable}"`)
    const order = cf.kind === 'created_by' ? 'ASC' : 'DESC'
    const actionFilter = cf.kind === 'created_by' ? "AND a.action = 'created'" : ''
    return {
      selectExpr:
        `(SELECT u.name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id ` +
        `WHERE a.entity_type = '${entity}' AND a.entity_id = ${erpTable}.id ${actionFilter} ` +
        `ORDER BY a.created_at ${order} LIMIT 1) AS ${cf.column_name}`,
      joins: [],
    }
  }
  throw new Error(`kind inconnu: ${cf.kind}`)
}

// Compile (sans exécuter) la colonne pour vérifier que ses références SQLite
// résolvent. Lève si une colonne/table référencée est absente.
function probeVirtualColumn(erpTable, selectExpr, joins) {
  const sql = `SELECT ${selectExpr} FROM ${erpTable}${joins.length ? ' ' + joins.join(' ') : ''} LIMIT 0`
  db.prepare(sql)
}

export function validateLookup({ lookup_fk, lookup_target_table, lookup_target_column }, erpTable) {
  if (!SAFE_IDENT.test(lookup_fk || '')) throw new Error('Colonne FK invalide')
  if (!SAFE_IDENT.test(lookup_target_table || '')) throw new Error('Table cible invalide')
  if (!SAFE_IDENT.test(lookup_target_column || '')) throw new Error('Colonne cible invalide')
  if (!LOOKUP_TARGET_WHITELIST.has(lookup_target_table)) {
    throw new Error(`Table "${lookup_target_table}" non autorisée pour lookup`)
  }
  // FK doit exister sur la table source
  const srcCols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
  if (!srcCols.includes(lookup_fk)) {
    throw new Error(`Colonne "${lookup_fk}" introuvable sur ${erpTable}`)
  }
  // Colonne cible doit exister sur la table cible
  const tgtCols = db.pragma(`table_info(${lookup_target_table})`).map(c => c.name)
  if (!tgtCols.includes(lookup_target_column)) {
    throw new Error(`Colonne "${lookup_target_column}" introuvable sur ${lookup_target_table}`)
  }
  if (!tgtCols.includes('id')) {
    throw new Error(`Table cible "${lookup_target_table}" sans colonne id — lookup non supporté`)
  }
}

export function validateRollup({ rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg }, erpTable) {
  if (!SAFE_IDENT.test(rollup_target_table || '')) throw new Error('Table source du rollup invalide')
  if (!SAFE_IDENT.test(rollup_target_fk || '')) throw new Error('Colonne FK inverse invalide')
  if (!LOOKUP_TARGET_WHITELIST.has(rollup_target_table)) {
    throw new Error(`Table "${rollup_target_table}" non autorisée pour rollup`)
  }
  const agg = String(rollup_agg || '').toUpperCase()
  if (!ROLLUP_AGGS.has(agg)) {
    throw new Error("rollup_agg doit être 'SUM', 'COUNT', 'AVG', 'MIN' ou 'MAX'")
  }
  // La source doit avoir une colonne id (cible du FK inverse)
  const srcCols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
  if (!srcCols.includes('id')) {
    throw new Error(`Table ${erpTable} sans colonne id — rollup non supporté`)
  }
  // La colonne FK inverse doit exister sur la table enfant
  const childCols = db.pragma(`table_info(${rollup_target_table})`).map(c => c.name)
  if (!childCols.includes(rollup_target_fk)) {
    throw new Error(`Colonne "${rollup_target_fk}" introuvable sur ${rollup_target_table}`)
  }
  // Colonne à agréger : requise sauf pour COUNT (qui fait COUNT(*))
  if (agg !== 'COUNT') {
    if (!SAFE_IDENT.test(rollup_target_column || '')) throw new Error('Colonne à agréger invalide')
    if (!childCols.includes(rollup_target_column)) {
      throw new Error(`Colonne "${rollup_target_column}" introuvable sur ${rollup_target_table}`)
    }
    if (!isSafeLookupColumn(rollup_target_column)) {
      throw new Error(`Colonne "${rollup_target_column}" non exposable (sensible)`)
    }
  }
}

// Valide la config d'un champ link. `link_target_table` doit être une table
// SAFE_IDENT possédant une colonne id ; la table source aussi. La whitelist
// applicative (tables gérables) est vérifiée côté route.
export function validateLink({ link_target_table }, erpTable) {
  if (!SAFE_IDENT.test(erpTable || '')) throw new Error('Nom de table invalide')
  if (!SAFE_IDENT.test(link_target_table || '')) throw new Error('Table cible invalide')
  const srcCols = db.pragma(`table_info(${erpTable})`).map(c => c.name)
  if (!srcCols.includes('id')) throw new Error(`Table ${erpTable} sans colonne id — liaison non supportée`)
  let tgtCols
  try { tgtCols = db.pragma(`table_info(${link_target_table})`).map(c => c.name) }
  catch { throw new Error(`Table "${link_target_table}" introuvable`) }
  if (!tgtCols.includes('id')) throw new Error(`Table cible "${link_target_table}" sans colonne id`)
}

// Colonnes de jonction occupées par CE champ selon son rôle. role='source' →
// ce record est dans source_id, les liés dans target_id (et inversement).
function linkColumns(role) {
  return role === 'target'
    ? { mine: 'target_id', other: 'source_id' }
    : { mine: 'source_id', other: 'target_id' }
}

// Tables canoniques du groupe de liaison (orientation figée à la création).
function linkGroupTables(field) {
  return field.link_role === 'source'
    ? { source_table: field.erp_table, target_table: field.link_target_table }
    : { source_table: field.link_target_table, target_table: field.erp_table }
}

// Lit la valeur d'un champ link pour un record : tableau [{id,label}] des records
// liés (cible non supprimée). Utilisé par les routes value/options.
export function readLinkValue(field, recordId) {
  validateLink(field, field.erp_table)
  const { mine, other } = linkColumns(field.link_role)
  const tgt = field.link_target_table
  const labelCol = labelColumnFor(tgt)
  const tgtCols = db.pragma(`table_info(${tgt})`).map(c => c.name)
  const softFilter = tgtCols.includes('deleted_at') ? ` AND t.deleted_at IS NULL` : ''
  const rows = db.prepare(
    `SELECT t.id AS id, t.${labelCol} AS label
     FROM custom_field_links j JOIN ${tgt} t ON t.id = j.${other}
     WHERE j.link_group_id = ? AND j.${mine} = ?${softFilter}
     ORDER BY j.created_at`
  ).all(field.link_group_id, String(recordId))
  return rows.map(r => ({ id: r.id, label: r.label }))
}

// Remplace l'ensemble des records liés à `recordId` pour ce champ link.
// Respecte la cardinalité :
//   - si CE côté est `link_single`, au plus 1 cible.
//   - si le côté INVERSE est `link_single`, chaque cible ne peut être liée qu'à
//     un seul record de ce côté → on détache la cible de son ancien partenaire.
// La jonction étant partagée, le champ inverse reflète la modification
// instantanément (bidirectionnel). Retourne la nouvelle liste [{id,label}].
export function setLinkValue(field, recordId, targetIds) {
  validateLink(field, field.erp_table)
  const ids = Array.isArray(targetIds)
    ? [...new Set(targetIds.map(v => String(v)).filter(Boolean))]
    : []
  if (field.link_single && ids.length > 1) {
    throw new Error('Ce champ n’accepte qu’un seul enregistrement lié')
  }
  const recId = String(recordId)
  if (!db.prepare(`SELECT 1 FROM ${field.erp_table} WHERE id=?`).get(recId)) {
    throw new Error('Enregistrement source introuvable')
  }
  const tgt = field.link_target_table
  if (ids.length) {
    const ph = ids.map(() => '?').join(',')
    const found = db.prepare(`SELECT id FROM ${tgt} WHERE id IN (${ph})`).all(...ids).map(r => String(r.id))
    if (found.length !== ids.length) throw new Error('Enregistrement(s) cible(s) introuvable(s)')
  }
  const inverse = db.prepare(
    `SELECT link_single FROM custom_fields WHERE link_group_id=? AND link_role=? AND deleted_at IS NULL`
  ).get(field.link_group_id, field.link_role === 'source' ? 'target' : 'source')
  const inverseSingle = !!(inverse && inverse.link_single)

  const { mine, other } = linkColumns(field.link_role)
  const { source_table, target_table } = linkGroupTables(field)

  const tx = db.transaction(() => {
    // Détache les liens actuels de CE record.
    db.prepare(`DELETE FROM custom_field_links WHERE link_group_id=? AND ${mine}=?`).run(field.link_group_id, recId)
    const insert = db.prepare(
      `INSERT OR IGNORE INTO custom_field_links (id, link_group_id, source_table, source_id, target_table, target_id)
       VALUES (?,?,?,?,?,?)`
    )
    const detachOther = db.prepare(`DELETE FROM custom_field_links WHERE link_group_id=? AND ${other}=?`)
    for (const tid of ids) {
      // Cardinalité inverse : la cible ne peut avoir qu'un partenaire de ce côté.
      if (inverseSingle) detachOther.run(field.link_group_id, tid)
      const source_id = field.link_role === 'source' ? recId : tid
      const target_id = field.link_role === 'source' ? tid : recId
      insert.run(uuid(), field.link_group_id, source_table, source_id, target_table, target_id)
    }
  })
  tx()
  return readLinkValue(field, recId)
}

// Options sélectionnables pour un champ link : records de la table cible
// (id + label), filtrés par `q`, limités. Lecture seule.
export function getLinkOptions(field, q, limit = 50) {
  validateLink(field, field.erp_table)
  const tgt = field.link_target_table
  const labelCol = labelColumnFor(tgt)
  const tgtCols = db.pragma(`table_info(${tgt})`).map(c => c.name)
  const where = []
  const params = []
  if (tgtCols.includes('deleted_at')) where.push('deleted_at IS NULL')
  const term = String(q || '').trim()
  if (term) { where.push(`${labelCol} LIKE ?`); params.push(`%${term}%`) }
  const n = Math.max(1, Math.min(200, parseInt(limit) || 50))
  const sql = `SELECT id, ${labelCol} AS label FROM ${tgt}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${labelCol} LIMIT ${n}`
  return db.prepare(sql).all(...params).map(r => ({ id: r.id, label: r.label }))
}

// Supprime toutes les lignes de jonction d'un groupe de liaison (à appeler quand
// on supprime un champ link, qui emporte aussi son inverse).
export function deleteLinkGroup(linkGroupId) {
  db.prepare(`DELETE FROM custom_field_links WHERE link_group_id=?`).run(linkGroupId)
}

// Extrait les column_name d'AUTRES champs custom référencés par une expression
// formule. On retire d'abord les littéraux chaîne SQLite ('...') pour ne pas
// confondre un mot dans du texte avec une référence de colonne. Les identifiants
// entre guillemets doubles ("col") restent (SQLite = identifiant), donc une
// référence quotée est bien captée. Ne renvoie que les tokens correspondant à un
// column_name connu (présent dans cfByColumn) — y compris la colonne elle-même
// si auto-référencée : on laisse la détection de cycle s'en charger.
function extractFormulaDeps(expr, cfByColumn) {
  const stripped = String(expr).replace(/'(?:[^']|'')*'/g, "''")
  const deps = new Set()
  const re = /[a-zA-Z_][a-zA-Z0-9_]*/g
  let m
  while ((m = re.exec(stripped))) {
    if (cfByColumn.has(m[0])) deps.add(m[0])
  }
  return deps
}

// Ordonne les colonnes virtuelles par profondeur de dépendance et détecte les
// cycles. Renvoie { levelByColumn: Map<column_name, niveau>, cyclicColumns:
// Set<column_name> }.
//   - niveau 0 : ne dépend d'aucun autre champ custom (référence uniquement des
//     colonnes physiques / JOIN) — calculé dans la couche interne de la vue.
//   - niveau N : 1 + max(niveau des champs custom référencés).
//   - colonnes d'un cycle : niveau 0 et signalées dans cyclicColumns (l'appelant
//     les dégrade en NULL avec un view_error).
// Détection de cycle : DFS tricolore (back-edge vers un nœud GRAY = cycle ; on
// marque tous les nœuds de la pile depuis le nœud rebouclé).
function computeDependencyLevels(virtualCols, cfByColumn, depsByColumn) {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map(virtualCols.map(cf => [cf.column_name, WHITE]))
  const cyclic = new Set()
  const stack = []
  function dfs(col) {
    color.set(col, GRAY)
    stack.push(col)
    for (const dep of depsByColumn.get(col) || []) {
      if (!color.has(dep)) continue
      if (color.get(dep) === GRAY) {
        const idx = stack.indexOf(dep)
        for (let i = idx; i < stack.length; i++) cyclic.add(stack[i])
      } else if (color.get(dep) === WHITE) {
        dfs(dep)
      }
    }
    stack.pop()
    color.set(col, BLACK)
  }
  for (const cf of virtualCols) {
    if (color.get(cf.column_name) === WHITE) dfs(cf.column_name)
  }

  // Niveaux mémoïsés. Les nœuds cycliques renvoient 0 (ils seront émis NULL en
  // couche 0) : un champ sain qui en dépend reste calculable (il lira NULL).
  const level = new Map()
  function lvl(col) {
    if (level.has(col)) return level.get(col)
    if (cyclic.has(col)) { level.set(col, 0); return 0 }
    const deps = depsByColumn.get(col) || new Set()
    let max = -1
    for (const dep of deps) {
      if (!cfByColumn.has(dep)) continue
      const dl = lvl(dep)
      if (dl > max) max = dl
    }
    const result = deps.size === 0 ? 0 : max + 1
    level.set(col, result)
    return result
  }
  for (const cf of virtualCols) lvl(cf.column_name)
  return { levelByColumn: level, cyclicColumns: cyclic }
}

// Rapport d'usage d'un champ : retourne les AUTRES champs custom actifs de la
// même table qui le référencent. Sert à prévenir, AU MOMENT du delete/rename,
// qu'on s'apprête à casser des champs calculés — au lieu de ne le découvrir
// qu'à la régénération silencieuse de la vue (#ERROR muet).
//
// Sources de dépendance détectées :
//   - formule    : l'expression mentionne le column_name du champ (via
//                  extractFormulaDeps, qui ignore les littéraux chaîne).
//   - lookup     : le champ supprimé sert de clé étrangère (lookup_fk) au lookup.
//   - rollup     : un rollup vit sur les colonnes de la table ENFANT, jamais sur
//                  les colonnes de CETTE table → pas de dépendance intra-table.
//   - auto       : champs système, ne référencent rien → ignorés comme sources.
//
// `field` : { id, erp_table, column_name } (au minimum). Renvoie un tableau
// d'objets { id, name, column_name, kind, relation } (relation = libellé FR).
export function getFieldDependents(field) {
  const { id, erp_table, column_name } = field || {}
  if (!SAFE_IDENT.test(erp_table || '')) throw new Error('Nom de table invalide')
  if (!column_name) return []
  const others = db.prepare(`
    SELECT id, name, column_name, kind, formula_expr, lookup_fk
    FROM custom_fields
    WHERE erp_table = ? AND deleted_at IS NULL AND id <> ?
      AND kind IN ('formula', 'lookup')
  `).all(erp_table, id)
  // extractFormulaDeps ne renvoie que les tokens présents dans cfByColumn : on y
  // place le column_name à tester, sinon une formule qui le référence ne serait
  // pas captée.
  const cfByColumn = new Map([[column_name, true]])
  const deps = []
  for (const o of others) {
    if (o.kind === 'formula' && o.formula_expr) {
      if (extractFormulaDeps(o.formula_expr, cfByColumn).has(column_name)) {
        deps.push({ id: o.id, name: o.name, column_name: o.column_name, kind: o.kind, relation: 'formule' })
      }
    } else if (o.kind === 'lookup' && o.lookup_fk === column_name) {
      deps.push({ id: o.id, name: o.name, column_name: o.column_name, kind: o.kind, relation: 'clé étrangère du lookup' })
    }
  }
  return deps
}

// Régénère la vue <erpTable>_v. Idempotent. À appeler après tout INSERT /
// UPDATE / DELETE sur custom_fields pour cette table.
export function regenerateView(erpTable) {
  if (!SAFE_IDENT.test(erpTable)) throw new Error('Nom de table invalide')

  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(erpTable)
  if (!tableExists) throw new Error(`Table ${erpTable} introuvable`)

  const virtualCols = db.prepare(`
    SELECT id, name, column_name, kind, formula_expr,
           lookup_fk, lookup_target_table, lookup_target_column, result_type,
           rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg,
           link_target_table, link_group_id, link_role, link_single
    FROM custom_fields
    WHERE erp_table = ? AND deleted_at IS NULL
      AND kind IN ('formula', 'lookup', 'rollup', 'link', 'created_time', 'last_modified_time', 'created_by', 'last_modified_by')
    ORDER BY sort_order, created_at
  `).all(erpTable)

  const viewName = `${erpTable}_v`

  // Cas trivial — pas de champs virtuels : la vue est un simple alias.
  // Permet aux routes de toujours requêter <table>_v sans branche conditionnelle.
  if (virtualCols.length === 0) {
    const tx = db.transaction(() => {
      db.exec(`DROP VIEW IF EXISTS ${viewName}`)
      db.exec(`CREATE VIEW ${viewName} AS SELECT * FROM ${erpTable}`)
    })
    tx()
    return { view: viewName, columns: 0 }
  }

  for (const cf of virtualCols) {
    if (!SAFE_IDENT.test(cf.column_name)) {
      throw new Error(`column_name invalide: ${cf.column_name}`)
    }
  }

  // Graphe de dépendances : chaque formule peut référencer d'autres champs
  // custom (formule/lookup/rollup/auto) de la même table. On en déduit, par
  // colonne, l'ensemble des column_name référencés, puis un niveau de profondeur
  // (et les cycles éventuels).
  const cfByColumn = new Map(virtualCols.map(cf => [cf.column_name, cf]))
  const depsByColumn = new Map()
  for (const cf of virtualCols) {
    depsByColumn.set(
      cf.column_name,
      (cf.kind === 'formula' && cf.formula_expr) ? extractFormulaDeps(cf.formula_expr, cfByColumn) : new Set(),
    )
  }
  const { levelByColumn, cyclicColumns } = computeDependencyLevels(virtualCols, cfByColumn, depsByColumn)

  // Regroupe les colonnes par niveau, en préservant l'ordre (sort_order) dans
  // chaque niveau.
  const maxLevel = virtualCols.reduce((m, cf) => Math.max(m, levelByColumn.get(cf.column_name) || 0), 0)
  const byLevel = Array.from({ length: maxLevel + 1 }, () => [])
  for (const cf of virtualCols) byLevel[levelByColumn.get(cf.column_name) || 0].push(cf)

  const alias = { n: 0 }
  // cf.id → message d'erreur (string) ou null si sain. Persisté en fin de tx
  // dans custom_fields.view_error pour que le client distingue #ERROR de « vide ».
  const errorsById = new Map()
  // JOINs des lookups : toujours dans la couche 0 (interne) car leurs alias
  // (_jN) ne vivent que dans le FROM de cette couche.
  const baseJoins = []
  let innerSql = ''

  for (let lv = 0; lv <= maxLevel; lv++) {
    // Couche 0 : on part de la table physique (`table.*`). Couches supérieures :
    // on enveloppe la couche précédente (`*` ré-expose toutes ses colonnes, dont
    // les champs custom calculés en-dessous, désormais résolvables par SQLite).
    const exprs = [lv === 0 ? `${erpTable}.*` : '*']
    for (const cf of byLevel[lv]) {
      if (cyclicColumns.has(cf.column_name)) {
        exprs.push(`NULL AS ${cf.column_name}`)
        errorsById.set(cf.id, 'Référence circulaire entre champs formule')
        continue
      }
      if (lv === 0) {
        try {
          const { selectExpr, joins: colJoins } = buildVirtualColumn(cf, erpTable, alias)
          // Sonde : si une colonne source a été supprimée/renommée, le prepare lève.
          probeVirtualColumn(erpTable, selectExpr, colJoins)
          exprs.push(selectExpr)
          baseJoins.push(...colJoins)
          errorsById.set(cf.id, null)
        } catch (e) {
          // Colonne cassée → on la dégrade en NULL pour que le reste de la vue (et
          // donc toute la lecture de la table) continue de fonctionner. L'erreur est
          // enregistrée : le client affiche #ERROR au lieu d'un « — » muet.
          exprs.push(`NULL AS ${cf.column_name}`)
          errorsById.set(cf.id, e.message || 'Erreur de formule')
        }
      } else {
        // Couche > 0 : uniquement des formules dont les dépendances sont déjà
        // calculées dans innerSql (couches inférieures). On sonde l'expression
        // contre cette sous-requête : si une référence reste introuvable, dégrade.
        try {
          validateFormulaExpr(cf.formula_expr)
          db.prepare(`SELECT (${cf.formula_expr}) AS _probe FROM (${innerSql}) LIMIT 0`)
          exprs.push(`(${cf.formula_expr}) AS ${cf.column_name}`)
          errorsById.set(cf.id, null)
        } catch (e) {
          const mm = /no such column:\s*(\S+)/i.exec(e.message || '')
          exprs.push(`NULL AS ${cf.column_name}`)
          errorsById.set(cf.id, mm ? `Colonne référencée introuvable : « ${mm[1]} »` : (e.message || 'Erreur de formule'))
        }
      }
    }
    innerSql = (lv === 0)
      ? `SELECT ${exprs.join(', ')}\nFROM ${erpTable}${baseJoins.length ? '\n' + baseJoins.join('\n') : ''}`
      : `SELECT ${exprs.join(', ')}\nFROM (${innerSql})`
  }

  const sql = `CREATE VIEW ${viewName} AS\n${innerSql}`

  const updErr = db.prepare(`UPDATE custom_fields SET view_error=? WHERE id=?`)
  const tx = db.transaction(() => {
    db.exec(`DROP VIEW IF EXISTS ${viewName}`)
    db.exec(sql)
    for (const [id, msg] of errorsById) updErr.run(msg, id)
  })
  tx()
  const errors = [...errorsById].filter(([, m]) => m).map(([id, message]) => ({ id, message }))
  return { view: viewName, columns: virtualCols.length, sql, errors }
}

// Régénère toutes les vues actives. À appeler au démarrage du serveur pour
// auto-réparer après ajout/retrait d'une colonne sur la table source ou
// modification du schéma de custom_fields.
export function regenerateAllViews() {
  const tables = db.prepare(`
    SELECT DISTINCT erp_table FROM custom_fields
    WHERE deleted_at IS NULL
      AND kind IN ('formula', 'lookup', 'rollup', 'link', 'created_time', 'last_modified_time', 'created_by', 'last_modified_by')
  `).all().map(r => r.erp_table)
  const results = []
  for (const t of tables) {
    try {
      results.push(regenerateView(t))
    } catch (e) {
      console.error(`❌ regenerateView(${t}):`, e.message)
      results.push({ view: `${t}_v`, error: e.message })
    }
  }
  return results
}
