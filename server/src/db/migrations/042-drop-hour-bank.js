/**
 * 042 — Retrait de la banque d'heures.
 *
 * La fonctionnalité (page /banque-heures, routes /api/hour-bank, écriture de
 * l'écart heures réelles / heures contractuelles depuis l'import des feuilles
 * de temps) n'est pas utilisée. Tout son code est retiré ; il reste à faire
 * partir la table.
 *
 * Aucune autre table ne pointe vers `hour_bank_entries` (vérifié dans
 * sqlite_master : la table et ses deux index sont les seuls objets à la
 * mentionner), donc pas de FK pendante après le DROP — cf.
 * gotcha « DROP TABLE casse les prepare via FK pendante ». Le `CREATE TABLE`
 * a été retiré de schema.js dans le même lot, sinon initSchema() la
 * recréerait à chaque démarrage juste avant que cette migration ne s'exécute.
 *
 * Les lignes sont écrites en JSON avant suppression, sous
 * uploads/db-archive/dropped-<horodatage>/, comme la migration 002.
 */

import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

export const id = '042-drop-hour-bank'
export const description = "Supprime la table hour_bank_entries (fonctionnalité banque d'heures retirée)"

export function up(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hour_bank_entries'").get()
  if (!exists) return

  const rows = db.prepare('SELECT * FROM hour_bank_entries').all()
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='hour_bank_entries'").get()?.sql || null

  const base = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(base, 'db-archive', `dropped-${stamp}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'hour_bank_entries.json'),
    JSON.stringify({ table: 'hour_bank_entries', dropped_at: new Date().toISOString(), ddl, row_count: rows.length, rows }, null, 2)
  )

  // Les index attachés partent avec la table.
  db.exec('DROP TABLE hour_bank_entries')
  console.log(`↪ hour_bank_entries supprimée (${rows.length} lignes archivées) → ${dir}`)
}
