/**
 * 116 — Ce que l'IA a déduit d'un libellé du relevé.
 *
 * Demande de Charles (2026-10-06) : quand ni l'ERP ni QuickBooks n'ont jamais
 * vu un libellé, raisonner sur la nature de la transaction et proposer le
 * compte. La déduction est gardée par libellé : on ne repose pas la question
 * à chaque ouverture de la ligne.
 */
export const id = '116-bank-ai-guesses'
export const description = 'déductions IA par libellé du relevé'

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_ai_guesses (
      key TEXT PRIMARY KEY,
      guess TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  return { table: 'bank_ai_guesses' }
}
