/**
 * Registre de migrations — le complément de schema.js, pas son remplaçant.
 *
 * Pourquoi. Toute la DDL vivait dans `schema.js` sous forme additive et
 * idempotente (`CREATE TABLE IF NOT EXISTS`, `try { ALTER } catch {}`). Le
 * pattern fonctionne mais il ne sait faire qu'UNE chose : ajouter. Il ne sait
 * pas supprimer une table devenue morte, ni dire si un changement a déjà été
 * appliqué, ni détecter que la base et le schéma déclaré ont divergé. Résultat
 * mesuré le 2026-09-02 : 180 tables en base pour 158 déclarées, et 455
 * `ALTER TABLE` en try/catch dont personne ne sait lesquels sont encore utiles.
 *
 * Ce que ça change. `schema.js` est gelé comme socle historique — on ne réécrit
 * pas 5 279 lignes sur une base de production. Mais rien de nouveau n'y entre :
 * tout changement de schéma devient un fichier numéroté dans `migrations/`,
 * appliqué une seule fois et tracé dans `schema_migrations`. Les suppressions
 * et les renommages redeviennent exprimables.
 *
 * Ordre d'exécution : APRÈS `initSchema()` — une migration peut avoir besoin
 * d'une table que schema.js vient de créer — et avant tout ce qui lit des
 * données (seeds, vues, syncs).
 *
 * Écrire une migration
 *   1. `migrations/<NNN>-<slug>.js`, numéro strictement croissant.
 *   2. `export const id = '<NNN>-<slug>'` (doit égaler le nom de fichier)
 *      `export const description = 'une phrase, pour le log'`
 *      `export function up(db) { … }`
 *   3. `up()` tourne dans une transaction : soit tout passe, soit rien.
 *      Une exception laisse la base intacte et ARRÊTE le démarrage — une
 *      migration à moitié appliquée est pire qu'un serveur qui refuse de
 *      partir. Écrire `up()` défensivement (vérifier l'existence avant de
 *      supprimer) plutôt que compter sur un try/catch avalé.
 */

import { readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import db from './database.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

const FILE_RE = /^(\d{3,})-[a-z0-9-]+\.js$/

function ensureLedger() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      description TEXT,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      duration_ms INTEGER
    )
  `)
}

function discover() {
  let names
  try { names = readdirSync(MIGRATIONS_DIR) }
  catch { return [] } // dossier absent = aucune migration, cas normal
  return names
    .filter(n => FILE_RE.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

/**
 * Applique les migrations en attente. Retourne la liste des ids appliqués.
 * Lève si une migration échoue — l'appelant (index.js) laisse remonter pour
 * que pm2 redémarre en boucle visible plutôt que de servir une base à moitié
 * migrée.
 */
export async function runMigrations() {
  ensureLedger()
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id))
  const files = discover()
  const done = []

  for (const file of files) {
    const expectedId = file.replace(/\.js$/, '')
    if (applied.has(expectedId)) continue

    const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href)
    if (mod.id && mod.id !== expectedId) {
      throw new Error(`Migration ${file}: l'id exporté « ${mod.id} » ne correspond pas au nom de fichier`)
    }
    if (typeof mod.up !== 'function') {
      throw new Error(`Migration ${file}: pas de fonction up(db) exportée`)
    }

    const t0 = Date.now()
    // Une transaction par migration : la table du registre est écrite DANS la
    // même transaction que le changement de schéma, donc les deux sont toujours
    // d'accord — jamais un changement appliqué mais non tracé.
    db.transaction(() => {
      mod.up(db)
      db.prepare('INSERT INTO schema_migrations (id, description, duration_ms) VALUES (?,?,?)')
        .run(expectedId, mod.description || null, Date.now() - t0)
    })()
    console.log(`↪ migration ${expectedId} appliquée (${Date.now() - t0}ms)${mod.description ? ` — ${mod.description}` : ''}`)
    done.push(expectedId)
  }

  return done
}
