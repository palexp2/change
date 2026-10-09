// Cochage automatique du travail récurrent « E/J mensuelle » d'Antoine.
//
// Le travail EST fait quand les écritures de fin de mois du mois visé sont dans
// QuickBooks : chaque provision active publiée (ou sans montant ce mois-là) et
// plus aucune ligne FPA à publier. Au moins une provision doit être publiée —
// des heures R&D pas encore importées donnent un montant nul, pas un mois fini.
import { listRecurringTasks, completeFromAutomation } from './recurringWork.js'
import { monthEndState } from './monthEnd.js'
import { buildFpaMonth } from './prepaid.js'

export const MONTH_END_TASK_ID = 'rt-al-ej-mensuelle'

export function monthEndEntriesDone(month) {
  const active = monthEndState(month).provisions.filter(p => p.active)
  const pushed = active.filter(p => p.pushed_at)
  if (!pushed.length) return false
  if (active.some(p => !p.pushed_at && p.amount > 0)) return false
  return buildFpaMonth(month).publishable_count === 0
}

/** Coche le travail pour la période courante et les rattrapages dont les écritures sont passées. */
export function syncMonthEndTask() {
  let task
  try { task = listRecurringTasks({ owner: 'AL' }).find(t => t.id === MONTH_END_TASK_ID) } catch (e) {
    console.warn(`[monthEndTask] ${e.message}`)
    return []
  }
  if (!task || task.cadence !== 'mensuel') return []
  const months = [...(task.done ? [] : [task.period_key]), ...(task.catch_up || []).map(p => p.period_key)]
  const done = []
  for (const month of months) {
    try {
      if (!monthEndEntriesDone(month)) continue
      completeFromAutomation(MONTH_END_TASK_ID, { periodKey: month, note: 'Écritures de fin de mois publiées dans QuickBooks' })
      done.push(month)
    } catch (e) {
      console.warn(`[monthEndTask] ${month} : ${e.message}`)
    }
  }
  return done
}
