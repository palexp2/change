// Reprise unique du fichier Drive « Annual Marketing budget » (onglets « 2025
// Réel » et « 2026 Réel ») dans Boréal (Charles, 2026-10-13) :
//   - ligne nommée (Luke, EFAO, Laurie…) → marketing_budget_items (budget + réel
//     saisis à la main, par mois) ;
//   - montant sans nom sous un compte (Ads 2026) → budget du compte
//     (marketing_budget_lines), seulement si la cellule est vide.
// Idempotent : une ligne déjà reprise (compte + nom + mois) n'est pas réécrite.
//   node src/scripts/import-annual-marketing-budget.js [--dry]
import db from '../db/database.js'
import { getSheetsClient } from '../connectors/google.js'
import { newRecordId } from '../utils/recordId.js'

const FILE = '1T7SJrnb4Wipxq-uxUtL_AtTdFfCXrc68wZTBds4es80'
const TABS = { '2025 Réel': 2025, '2026 Réel': 2026 }
const MONTHS = { avr: 4, apr: 4, mai: 5, may: 5, jun: 6, jui: 6, jul: 7, aug: 8, aoû: 8, sep: 9, oct: 10, nov: 11, dec: 12, déc: 12, jan: 1, feb: 2, fév: 2, mar: 3 }
const dry = process.argv.includes('--dry')
const r2 = n => Math.round(Number(n) * 100) / 100
const numOf = v => (typeof v === 'number' ? v : Number(String(v || '').replace(/[$\s,]/g, '')) || 0)

const acct = db.prepare("SELECT id FROM connector_oauth WHERE connector='google' AND account_email='michel@orisha.io' AND refresh_token IS NOT NULL").get()
const sheets = await getSheetsClient(acct.id)
const stats = { items: 0, cells: 0, skipped: 0 }

for (const [tab, fy] of Object.entries(TABS)) {
  const get = render => sheets.spreadsheets.values.get({ spreadsheetId: FILE, range: `'${tab}'!A1:AF80`, valueRenderOption: render }).then(r => r.data.values || [])
  const [shown, raw] = await Promise.all([get('FORMATTED_VALUE'), get('UNFORMATTED_VALUE')])
  // Colonnes Budget de chaque mois (ligne 1), la colonne Réel suit.
  const cols = []
  shown[0].forEach((h, c) => {
    const m = MONTHS[String(h).trim().toLowerCase().slice(0, 3)]
    if (m) cols.push({ c, month: `${m >= 4 ? fy : fy + 1}-${String(m).padStart(2, '0')}` })
  })
  let acctnum = null
  for (let r = 2; r < shown.length; r++) {
    const e = String(shown[r]?.[4] || '').trim()
    if (/^total/i.test(e)) break
    const hdr = e.match(/#(7\d{4})/)
    if (hdr || /QB:/i.test(e)) { acctnum = hdr ? hdr[1] : null; continue }
    if (!acctnum) continue
    for (const { c, month } of cols) {
      const budget = r2(numOf(raw[r]?.[c])), real = r2(numOf(raw[r]?.[c + 1]))
      if (!budget && !real) continue
      if (!e) {
        if (real) console.warn(`⚠️ ${tab} L${r + 1} : réel sans nom ignoré (${real})`)
        if (!budget) continue
        const has = db.prepare('SELECT 1 FROM marketing_budget_lines WHERE acctnum=? AND month=? AND deleted_at IS NULL').get(acctnum, month)
        if (has) { stats.skipped++; continue }
        console.log(`compte ${acctnum} ${month} budget ${budget}`)
        if (!dry) db.prepare('INSERT INTO marketing_budget_lines (id, acctnum, month, budget) VALUES (?,?,?,?)').run(newRecordId(), acctnum, month, budget)
        stats.cells++
        continue
      }
      const has = db.prepare('SELECT 1 FROM marketing_budget_items WHERE acctnum=? AND label=? AND month=? AND deleted_at IS NULL').get(acctnum, e, month)
      if (has) { stats.skipped++; continue }
      console.log(`${acctnum} ${e} ${month} budget ${budget} réel ${real}`)
      if (!dry) {
        db.prepare("INSERT INTO marketing_budget_items (id, acctnum, label, month, budget, real, source) VALUES (?,?,?,?,?,?,'annual_marketing_budget')")
          .run(newRecordId(), acctnum, e, month, budget, real)
      }
      stats.items++
    }
  }
}
console.log(dry ? '(simulation)' : '', stats)
process.exit(0)
