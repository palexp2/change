/**
 * 020 — `work_prompts.exec_lane` : quatre files d'implémentation en parallèle.
 *
 * La file de travaux ne poussait qu'UNE implémentation à la fois (l'agent n'avait
 * qu'un poste, puisque toutes les exécutions éditent le même arbre de travail).
 * Elle est désormais éclatée en quatre sous-files avançant en parallèle : chaque
 * item reçoit une file au hasard à sa création, et chaque file avance ses items
 * l'un après l'autre.
 *
 * Les items déjà en attente sont redistribués au hasard, sinon les quatre postes
 * démarreraient tous sur la file 0 (valeur par défaut) et rien n'irait plus vite.
 * Les items terminés gardent 0 : ils n'ont plus de tour à prendre.
 */
export const id = '020-work-prompts-exec-lane'
export const description = 'work_prompts.exec_lane — répartition aléatoire des travaux en 4 files parallèles'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(work_prompts)').all().map(c => c.name)
  let added = false
  if (!cols.includes('exec_lane')) {
    db.exec('ALTER TABLE work_prompts ADD COLUMN exec_lane INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      UPDATE work_prompts SET exec_lane = ABS(RANDOM()) % 4
      WHERE deleted_at IS NULL AND status IN ('queued','running','paused')
    `)
    added = true
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_prompts_lane ON work_prompts(exec_lane, status, position)')
  return { added }
}
