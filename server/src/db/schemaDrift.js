/**
 * Contrôle de dérive du schéma — journalise ce que personne ne surveillait.
 *
 * Le problème constaté le 2026-09-02 : 180 tables en base pour 158 déclarées
 * dans schema.js. L'écart n'avait rien de volontaire, il s'était simplement
 * accumulé sans que rien ne le signale — un moteur de tables abandonné, des
 * prédécesseurs du registre de champs, deux fonctionnalités retirées. Le pattern
 * additif de schema.js (`CREATE TABLE IF NOT EXISTS`, `try { ALTER } catch {}`)
 * ne peut pas détecter ça : il ne sait qu'ajouter, et un ALTER qui échoue est
 * indistinguable d'un ALTER déjà appliqué.
 *
 * Ce que fait ce contrôle : il liste les tables de la base, cherche un
 * `CREATE TABLE` correspondant dans les sources (schema.js n'est pas le seul
 * créateur — db/changeLog.js et services/relanceEmail.js créent aussi leurs
 * tables), et journalise les deux sens de l'écart. Il ne corrige RIEN et ne
 * bloque RIEN : une table non déclarée peut être parfaitement légitime le temps
 * d'un chantier. Le but est qu'elle soit vue.
 *
 * Portée volontairement limitée aux TABLES. Étendre aux colonnes produirait du
 * bruit sans valeur : les 455 ALTER TABLE en try/catch de schema.js ne disent
 * pas lesquelles de leurs colonnes sont encore utilisées, et une colonne
 * inutilisée ne coûte pratiquement rien — contrairement à une table entière de
 * 30 302 lignes.
 *
 * Tourne après le démarrage du serveur (jamais dans le chemin critique) et
 * uniquement en journal. `SCHEMA_DRIFT_CHECK=off` le désactive.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import db from './database.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(__dirname, '..')

// Tables créées par SQLite lui-même ou par une bibliothèque, jamais déclarées
// dans nos sources.
const SYSTEM_PREFIXES = ['sqlite_']

// Tables présentes en base sans CREATE TABLE dans les sources, et gardées
// EXPRÈS. Sans cette liste, le contrôle alerterait à chaque démarrage sur des
// exceptions déjà tranchées — et un avertissement permanent finit par ne plus
// être lu du tout. Y ajouter une entrée est une décision, pas un contournement :
// elle doit porter sa raison.
const ACCEPTED_UNDECLARED = {
  tenants:
    "lue par routes/documents.js pour l'en-tête des PDF de soumission ; " +
    'sa création vient d\'une installation antérieure à schema.js',
  vendor_directory_legacy:
    'copie de sécurité du dernier état du doc fournisseurs ; son existence ' +
    'empêche la migration vendor_directory de se rejouer (schema.js)',
}

function jsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      jsFiles(full, acc)
    } else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) {
      // Les tests créent leurs propres tables dans une base en mémoire
      // (ticket_blockers, par exemple) : ce ne sont pas des tables de
      // production, les compter fabriquerait une fausse absence.
      acc.push(full)
    }
  }
  return acc
}

// Noms de tables apparaissant dans un CREATE TABLE des sources, quelle que soit
// leur forme : avec ou sans IF NOT EXISTS, avec ou sans guillemets. La
// parenthèse ouvrante finale est obligatoire — c'est ce qui distingue une vraie
// DDL d'un « CREATE TABLE » cité dans un commentaire, qui faisait entrer des
// mots de prose française dans la liste des tables déclarées.
const CREATE_RE =
  /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s*\(/gi

// Retire commentaires de ligne et de bloc avant l'analyse. Le pattern de chaîne
// est volontairement grossier : il ne s'agit pas de parser du JavaScript, juste
// d'éviter de prendre un commentaire pour de la DDL.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

function declaredTables() {
  const declared = new Map() // table → fichier source (le premier trouvé)
  for (const file of jsFiles(SRC_DIR)) {
    let src
    try { src = readFileSync(file, 'utf8') } catch { continue }
    if (!src.includes('CREATE TABLE')) continue
    for (const m of stripComments(src).matchAll(CREATE_RE)) {
      const name = m[1]
      // Tables temporaires de reconstruction (`<table>_new`) : créées puis
      // renommées dans le même bloc guardé, elles n'existent jamais au repos.
      if (/_+new$/i.test(name)) continue
      if (!declared.has(name)) declared.set(name, path.relative(SRC_DIR, file))
    }
  }
  return declared
}

/**
 * Clés étrangères dont la table cible n'existe plus.
 *
 * `PRAGMA foreign_key_check` ne détecte PAS ce cas : il cherche des valeurs
 * orphelines, pas des cibles manquantes. Sur une base où `base_tables` venait
 * d'être supprimée alors que `automations.table_id` la référençait encore, il
 * répondait « 0 violation » — pendant que tout INSERT sur `automations` échouait.
 * Avec `foreign_keys = ON`, SQLite résout la table cible au moment du `prepare` :
 * une référence pendante ne casse pas une écriture, elle casse la préparation de
 * la requête, donc le démarrage du serveur.
 *
 * C'est le contrôle qui manquait le 2026-09-02. Il tient en trois lignes et
 * transforme une panne de démarrage en avertissement au boot précédent.
 */
export function danglingReferences() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  const known = new Set(tables)
  const dangling = []
  for (const table of tables) {
    if (SYSTEM_PREFIXES.some(p => table.startsWith(p))) continue
    let fks
    try { fks = db.pragma(`foreign_key_list("${table}")`) } catch { continue }
    for (const fk of fks) {
      if (!known.has(fk.table)) dangling.push({ table, column: fk.from, missing_target: fk.table })
    }
  }
  return dangling
}

/**
 * Compare la base aux sources et journalise l'écart. Retourne le rapport pour
 * les appelants qui veulent l'exposer (une route d'administration, un test).
 */
export function checkSchemaDrift() {
  if (process.env.SCHEMA_DRIFT_CHECK === 'off') return null

  const inDb = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(r => r.name)
    .filter(n => !SYSTEM_PREFIXES.some(p => n.startsWith(p)))

  const declared = declaredTables()

  const undeclared = inDb
    .filter(n => !declared.has(n) && !(n in ACCEPTED_UNDECLARED))
    .map(name => {
      let rows = null
      try { rows = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n } catch {}
      return { name, rows }
    })
  const accepted = inDb.filter(n => !declared.has(n) && n in ACCEPTED_UNDECLARED)
    .map(name => ({ name, reason: ACCEPTED_UNDECLARED[name] }))
  const missing = [...declared.keys()].filter(n => !inDb.includes(n))
    .map(name => ({ name, source: declared.get(name) }))

  const dangling = danglingReferences()

  const report = {
    checked_at: new Date().toISOString(),
    tables_in_db: inDb.length,
    tables_declared: declared.size,
    undeclared,
    accepted,
    missing,
    dangling,
  }

  if (undeclared.length) {
    console.warn(`⚠️  Dérive de schéma : ${undeclared.length} table(s) en base sans CREATE TABLE dans les sources —`)
    for (const t of undeclared) {
      console.warn(`     ${t.name}${t.rows === null ? '' : ` (${t.rows} ligne${t.rows === 1 ? '' : 's'})`}`)
    }
    console.warn('     Soit la table est morte (à supprimer par une migration), soit sa création est implicite.')
  }
  if (missing.length) {
    // Cas normal et fréquent : un CREATE TABLE conditionnel, ou une table
    // déclarée dans un script utilitaire qui n'a jamais tourné ici.
    console.log(`ℹ️  ${missing.length} table(s) déclarée(s) dans les sources et absente(s) de la base : ` +
      missing.map(t => t.name).join(', '))
  }
  if (dangling.length) {
    // Le seul écart qui casse vraiment quelque chose — d'où le ton.
    console.error(`❌ Références pendantes : ${dangling.length} clé(s) étrangère(s) pointent vers une table absente —`)
    for (const d of dangling) {
      console.error(`     ${d.table}.${d.column} → ${d.missing_target} (table supprimée)`)
    }
    console.error('     Tout INSERT sur ces tables échouera au prepare. À corriger par une migration.')
  }
  if (!undeclared.length && !dangling.length) {
    const exceptions = accepted.length ? ` (${accepted.length} exception(s) assumée(s))` : ''
    console.log(`✓ Schéma : ${inDb.length} tables, aucune dérive${exceptions}`)
  }

  return report
}
