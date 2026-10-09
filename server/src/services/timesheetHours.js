// Heures payables d'une journée de feuille de temps — une seule règle pour la
// page, les totaux par période et l'import de paie.
//
// Depuis la fusion des modes « simplifié » et « détaillé » (2026-10-03), une
// journée porte à la fois une arrivée/départ/pause ET des lignes d'activité
// facultatives qui ventilent la journée (R&D surtout). L'arrivée/départ fait
// foi quand les deux sont remplis ; sinon c'est la somme des lignes payables
// (les journées « détaillées » d'avant n'ont jamais de départ).

export function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(n => parseInt(n, 10) || 0)
  return h * 60 + m
}

export function clockMinutes(day) {
  if (!day?.start_time || !day?.end_time) return null
  return Math.max(0, hhmmToMin(day.end_time) - hhmmToMin(day.start_time) - (Number(day.break_minutes) || 0))
}

// `payableEntryMinutes` : somme des lignes dont le code est payable (ou sans code).
export function dayPayableMinutes(day, payableEntryMinutes) {
  const clock = clockMinutes(day)
  return clock != null ? clock : (Number(payableEntryMinutes) || 0)
}
