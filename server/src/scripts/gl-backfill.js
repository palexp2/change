#!/usr/bin/env node
/**
 * gl-backfill.js — importe tout l'historique QBO dans le grand livre miroir
 * (gl_entries / gl_lines). LECTURE SEULE côté QuickBooks.
 *
 * Usage
 *   node src/scripts/gl-backfill.js                      # du début de QBO à ce mois-ci
 *   node src/scripts/gl-backfill.js --from=2024-01 --to=2024-12
 */
import db from '../db/database.js'
import { importGlRange, findEarliestQbDate, glSummary } from '../services/glMirror.js'

const arg = (k) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
const from = arg('from') || await findEarliestQbDate()
const to = arg('to') || new Date().toISOString().slice(0, 10)
console.log(`Grand livre : import ${from.slice(0, 7)} → ${to.slice(0, 7)}`)

let problems = 0
await importGlRange(from, to, {
  onMonth: (r) => {
    if (r.error) { problems++; console.log(`${r.month}  ÉCHEC  ${r.error}`); return }
    if (r.issues.length) problems++
    console.log(`${r.month}  ${String(r.entries).padStart(5)} transactions  ${String(r.lines).padStart(6)} lignes${r.issues.length ? `  ⚠ ${r.issues.length}` : ''}`)
    for (const i of r.issues.slice(0, 5)) console.log(`         ${i}`)
  },
})

const s = glSummary()
const unbalanced = db.prepare(`
  SELECT COUNT(*) AS n FROM (SELECT entry_id FROM gl_lines GROUP BY entry_id HAVING ABS(SUM(debit) - SUM(credit)) > 0.01)
`).get().n
console.log(`\n${s.entries} transactions, ${s.lines} lignes, ${s.first_date} → ${s.last_date}`)
console.log(`Σ débits ${s.debit} · Σ crédits ${s.credit} · écart ${(s.debit - s.credit).toFixed(2)} · transactions déséquilibrées ${unbalanced}`)
console.log(problems ? `${problems} mois à revoir (gl_import_runs)` : 'Aucun mois en anomalie')
process.exit(problems ? 1 : 0)
