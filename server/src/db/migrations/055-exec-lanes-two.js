/**
 * 055 — deux files d'exécution : rapatrier les items restés sur les files 2 et 3.
 *
 * La file de travaux avançait sur QUATRE sous-files parallèles (migration 020).
 * Elle repasse à DEUX (`EXEC_LANES` dans services/taskRunner.js, demande du
 * 2026-09-12) : quatre chantiers simultanés sur le même arbre de travail se
 * marchaient dessus, et se disputaient une machine à 2 vCPU.
 *
 * Sans ce rapatriement, tout item encore en attente sur la file 2 ou 3 serait
 * ORPHELIN : l'ordonnanceur ne regarde plus que les files 0 et 1 (`exec_lane=?`
 * dans advanceQueue), donc il ne partirait jamais — sans rien afficher d'anormal.
 * On les répartit donc sur les deux files restantes en gardant la parité (2→0,
 * 3→1), ce qui conserve l'alternance d'origine.
 *
 * Les items terminés ne sont pas touchés : ils n'ont plus de tour à prendre, et
 * leur file d'origine reste une trace honnête de ce qui s'est passé.
 */
export const id = '055-exec-lanes-two'
export const description = 'work_prompts.exec_lane — items en attente ramenés sur les deux files restantes'

// Doit suivre EXEC_LANES (services/taskRunner.js). Une migration est figée dans le
// temps : on écrit la valeur du jour, pas un import qui bougerait plus tard.
const LANES = 2

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(work_prompts)').all().map(c => c.name)
  if (!cols.includes('exec_lane')) return { moved: 0 }
  const res = db.prepare(`
    UPDATE work_prompts SET exec_lane = exec_lane % ?
    WHERE deleted_at IS NULL AND status IN ('queued','running','paused') AND exec_lane >= ?
  `).run(LANES, LANES)
  return { moved: res.changes }
}
