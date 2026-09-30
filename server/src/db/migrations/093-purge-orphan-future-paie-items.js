/**
 * 093 — Purge des lignes de paie orphelines laissées par les tests e2e.
 *
 * Les tests paie (e2e/tests/paie-*.test.js) créent des paies datées 2029/2031
 * puis les suppriment ; `paie_items.paie_id` est en ON DELETE SET NULL, donc
 * leurs lignes survivaient sans paie. Comptées dans la banque de vacances
 * (postérieures au point de référence), elles la gonflaient (ex. +11 108 $).
 *
 * Cible : sans paie, sans Airtable, datées à partir de 2029 — aucune vraie
 * ligne ne répond à ces trois critères. Archivées dans uploads/db-archive/.
 */
import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'

export const id = '093-purge-orphan-future-paie-items'
export const description = 'paie_items : supprime les lignes orphelines futures créées par les tests'

const WHERE = `paie_id IS NULL AND airtable_id IS NULL AND start_date >= '2029-01-01'`

export function up(db) {
  const rows = db.prepare(`SELECT * FROM paie_items WHERE ${WHERE}`).all()
  if (!rows.length) return

  const base = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(base, 'db-archive', `dropped-${stamp}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'paie_items-orphan-future.json'),
    JSON.stringify({ table: 'paie_items', dropped_at: new Date().toISOString(), where: WHERE, row_count: rows.length, rows }, null, 2)
  )

  db.prepare(`DELETE FROM paie_items WHERE ${WHERE}`).run()
  console.log(`↪ paie_items : ${rows.length} lignes orphelines futures supprimées → ${dir}`)
}
