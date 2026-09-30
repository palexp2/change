// Le relevé de la prochaine échéance prime sur l'historique et la saisie.
// Une échéance passée reste pertinente seulement si elle est encore projetée.
export function nextRecurringStatements(projection) {
  const pending = new Set((projection?.days || []).flatMap(day => day.events || [])
    .filter(event => event.kind === 'recurring')
    .map(event => `${event.ref}:${event.original_date || event.date}`))
  const cleared = new Set((projection?.auto_cleared || [])
    .filter(event => event.kind === 'recurring')
    .map(event => `${event.ref}:${event.original_date}`))
  const today = projection?.days?.[0]?.date
  const result = new Map()
  for (const statement of [...(projection?.card_statements || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `${statement.id}:${statement.date}`
    if (cleared.has(key) || (today && statement.date < today && !pending.has(key))) continue
    if (!result.has(statement.id)) result.set(statement.id, statement)
  }
  return result
}
