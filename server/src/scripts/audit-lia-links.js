// Contrôle des rattachements « ligne de dépense ↔ achat LIA » — LECTURE SEULE.
//
//   node src/scripts/audit-lia-links.js          # rapport lisible
//   node src/scripts/audit-lia-links.js --json   # sortie brute
//
// Liste les lignes reliées à un achat qui n'était plus « À recevoir » à la date de la
// dépense (déjà reçu) et les achats désignés par plusieurs lignes. Rien n'est corrigé :
// la liste sert à décider, cas par cas. Cf. services/purchaseLinkAudit.js.
import { auditPurchaseLinks } from '../services/purchaseLinkAudit.js'

const r = auditPurchaseLinks()
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}
const src = l => (l.source === 'qb' ? `QB #${l.quickbooks_id}` : `reçu ERP ${l.record_id}`)
console.log(`${r.scanned} lignes de dépense reliées à un achat.\n`)
console.log(`DÉJÀ REÇU À LA DATE DE LA DÉPENSE (${r.alreadyReceived.length})`)
for (const l of r.alreadyReceived) {
  const recv = l.received_date <= '1970-01-02' ? 'date inconnue' : l.received_date
  console.log(`  ${l.date}  ${l.vendor || '?'}  réf. ${l.reference || '—'}  ${src(l)} l.${l.line}  →  ${l.lia_ref} commandé ${l.order_date || '?'}, reçu ${recv}  ${l.amount ?? ''} $`)
}
console.log(`\nRELIÉ PLUSIEURS FOIS (${r.doubles.length})`)
for (const d of r.doubles) {
  const at = d.purchase.airtable_links >= 2 ? `  [${d.purchase.airtable_links} liens Airtable]` : ''
  console.log(`  ${d.purchase.lia_ref} (commandé ${d.purchase.order_date || '?'})${at}`)
  for (const l of d.lines) console.log(`      ${l.date}  ${l.vendor || '?'}  réf. ${l.reference || '—'}  ${src(l)} l.${l.line}  ${l.amount ?? ''} $`)
}
if (r.unknown.length) console.log(`\n${r.unknown.length} ligne(s) portent un code LIA introuvable dans les achats.`)
process.exit(0)
