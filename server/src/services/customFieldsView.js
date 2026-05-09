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
// V1 — limitations connues :
//   - une formule ne peut référencer que les colonnes physiques de la table
//     source (pas un autre champ custom : SQLite ne résout pas les alias
//     SELECT au sein d'une même vue plate)
//   - une seule colonne par lookup (pour faire 2 colonnes du même record lié,
//     créer 2 lookups distincts — le query planner consolidera les JOIN)

import db from '../db/database.js'

// Whitelist des tables qu'on autorise comme cible de lookup. Exclut
// volontairement `users` (hashes de mots de passe), `oauth_tokens`,
// `automation_secrets`, etc.
export const LOOKUP_TARGET_WHITELIST = new Set([
  'companies', 'contacts', 'projects', 'orders', 'products', 'employees',
  'subscriptions', 'shipments', 'returns', 'tasks', 'factures', 'soumissions',
  'achats_fournisseurs', 'addresses', 'activity_codes',
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
  return { fk_columns: fkColumns, allowed_targets: [...LOOKUP_TARGET_WHITELIST], target_columns: targetColumns }
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
           lookup_fk, lookup_target_table, lookup_target_column, result_type
    FROM custom_fields
    WHERE erp_table = ? AND deleted_at IS NULL AND kind IN ('formula', 'lookup')
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

  const joins = []
  const selectExprs = [`${erpTable}.*`]
  let joinAlias = 0

  for (const cf of virtualCols) {
    if (!SAFE_IDENT.test(cf.column_name)) {
      throw new Error(`column_name invalide: ${cf.column_name}`)
    }
    if (cf.kind === 'formula') {
      validateFormulaExpr(cf.formula_expr)
      selectExprs.push(`(${cf.formula_expr}) AS ${cf.column_name}`)
    } else if (cf.kind === 'lookup') {
      validateLookup(cf, erpTable)
      const alias = `_j${++joinAlias}`
      joins.push(`LEFT JOIN ${cf.lookup_target_table} AS ${alias} ON ${alias}.id = ${erpTable}.${cf.lookup_fk}`)
      selectExprs.push(`${alias}.${cf.lookup_target_column} AS ${cf.column_name}`)
    }
  }

  const sql = `CREATE VIEW ${viewName} AS\nSELECT ${selectExprs.join(', ')}\nFROM ${erpTable}${joins.length ? '\n' + joins.join('\n') : ''}`

  const tx = db.transaction(() => {
    db.exec(`DROP VIEW IF EXISTS ${viewName}`)
    db.exec(sql)
  })
  tx()
  return { view: viewName, columns: virtualCols.length, sql }
}

// Régénère toutes les vues actives. À appeler au démarrage du serveur pour
// auto-réparer après ajout/retrait d'une colonne sur la table source ou
// modification du schéma de custom_fields.
export function regenerateAllViews() {
  const tables = db.prepare(`
    SELECT DISTINCT erp_table FROM custom_fields
    WHERE deleted_at IS NULL AND kind IN ('formula', 'lookup')
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
