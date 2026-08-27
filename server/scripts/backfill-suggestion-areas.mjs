// Backfill ponctuel : réaligne les valeurs libres de work_suggestions.area posées
// avant l'introduction de SUGGESTION_AREAS (enum fermé) sur ce même enum, via la
// fonction de normalisation utilisée pour toute nouvelle insertion. À lancer une
// seule fois après le déploiement du regroupement par domaine (page /travaux).
import db from '../src/db/database.js'
import { normalizeArea, SUGGESTION_AREAS } from '../src/services/workSuggestions.js'

const rows = db.prepare('SELECT id, area FROM work_suggestions WHERE deleted_at IS NULL').all()
let updated = 0
for (const row of rows) {
  if (SUGGESTION_AREAS.includes(row.area)) continue
  const next = normalizeArea(row.area)
  db.prepare('UPDATE work_suggestions SET area=? WHERE id=?').run(next, row.id)
  console.log(`${row.id}: "${row.area}" → "${next}"`)
  updated++
}
console.log(`${updated}/${rows.length} suggestion(s) mise(s) à jour`)
