/**
 * 117 — Ce que l'IA a lu d'une facture pour retrouver ses codes LIA.
 *
 * Demande de Charles (2026-10-06) : recouper les indices de toute la facture, pas
 * seulement le libellé mot pour mot. La lecture est gardée par empreinte (facture +
 * achats candidats) : on ne repose pas la question à chaque ouverture de la fiche.
 */
export const id = '117-lia-ai-matches'
export const description = 'lectures IA des codes LIA par facture'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lia_ai_matches (
      key TEXT PRIMARY KEY,
      result TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  return { table: 'lia_ai_matches' }
}
