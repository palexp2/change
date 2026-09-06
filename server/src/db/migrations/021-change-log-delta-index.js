/**
 * 021 — index couvrant pour `/api/bootstrap/delta`.
 *
 * Le delta est l'appel le plus fréquent de toute l'API : chaque onglet ouvert le
 * poll toutes les 10 s. Mesuré le 2026-09-04, il coûtait 115–130 ms *même quand
 * rien n'avait changé* — et comme Node est mono-thread, ces 120 ms bloquent tout
 * le reste, y compris index.html et le CSS de la coquille de la page.
 *
 * La cause : la requête cherchait la dernière entrée par (table, record) avec un
 * `GROUP BY table_name, record_id`, ce qui poussait SQLite à balayer les 166 620
 * lignes de `change_log` via `idx_change_log_table_record` au lieu de se
 * restreindre à la tranche `changed_at > ?` :
 *
 *   SCAN change_log USING INDEX idx_change_log_table_record
 *
 * Cet index rend la tranche lisible en index-only et dans le bon ordre
 * (`changed_at, id`), donc sans tri :
 *
 *   SEARCH change_log USING COVERING INDEX idx_change_log_delta (changed_at>?)
 *
 * Le dédoublonnage « dernière entrée par record » passe côté JS (voir
 * routes/bootstrap.js) : sur une tranche de quelques dizaines de lignes c'est
 * gratuit, alors que c'était lui qui imposait le mauvais plan. Résultat mesuré
 * sur une copie de la base de prod : 118 ms → 0,04 ms.
 *
 * `idx_change_log_table_record` est conservé : les watchers lisent bien
 * `change_log` par table.
 */
export const id = '021-change-log-delta-index'
export const description = 'index couvrant change_log(changed_at, id, …) — delta 118 ms → 0,04 ms'

export function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_change_log_delta
      ON change_log(changed_at, id, table_name, record_id, change_type)
  `)
  return { created: 'idx_change_log_delta' }
}
