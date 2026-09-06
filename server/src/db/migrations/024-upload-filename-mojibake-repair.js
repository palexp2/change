/**
 * 024 — réparation : noms de fichiers accentués illisibles.
 *
 * multer lisait l'en-tête `filename` du multipart en latin1 (son défaut) : un
 * nom UTF-8 accentué a été stocké tel quel, octet par octet, et s'affichait
 * « Capture dâ€™eÌcran, le 2026-09-04 aÌ 09.49.27.png ». Les routes
 * d'upload passent maintenant `defParamCharset: 'utf8'` ; restent les lignes
 * déjà en base.
 *
 * Deux passes sur chaque colonne de nom d'origine : redécodage du mojibake
 * (sans risque, cf. utils/uploadFileName.js) puis normalisation NFC — macOS
 * envoie ses accents décomposés, ce qui s'affiche bien mais ne se cherche pas
 * comme le reste. Ces colonnes ne servent qu'à l'affichage (le fichier sur
 * disque porte un UUID), sauf `calls.original_filename` qui sert de clé de
 * déduplication FTP : la route la normalise désormais aussi, les deux côtés
 * restent alignés.
 *
 * Idempotent : une valeur déjà correcte est laissée intacte.
 */
import { normalizeUploadName } from '../../utils/uploadFileName.js'

export const id = '024-upload-filename-mojibake-repair'
export const description = 'Noms de fichiers téléversés : mojibake latin1 redécodé, accents en NFC'

const TARGETS = [
  ['public_files', 'id', 'original_name'],
  ['sale_receipts', 'id', 'original_name'],
  ['attachments', 'id', 'file_name'],
  ['calls', 'id', 'original_filename'],
]

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)
  } catch { return false }
}

export function up(db) {
  const repaired = {}
  for (const [table, pk, col] of TARGETS) {
    if (!hasColumn(db, table, col)) continue
    const update = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pk} = ?`)
    let n = 0
    const rows = db.prepare(`SELECT ${pk} AS pk, ${col} AS name FROM ${table} WHERE ${col} IS NOT NULL`).all()
    for (const row of rows) {
      const fixed = normalizeUploadName(row.name)
      if (fixed !== row.name) { update.run(fixed, row.pk); n++ }
    }
    if (n) repaired[`${table}.${col}`] = n
  }
  return Object.keys(repaired).length ? repaired : { skipped: 'aucun nom à réparer' }
}
