#!/usr/bin/env node
// One-shot : exécute le backfill remboursements (durci) qui consolide les
// doublons (ch_xxx Airtable + re_xxx natif) en gardant la ligne native.
// Usage : node src/scripts/dedup-stripe-refunds.mjs [--dry-run]
import { backfillRefundsToFactures } from '../services/stripe.js'

const dryRun = process.argv.includes('--dry-run')
console.log(dryRun ? '🔍 DRY-RUN — aucune écriture' : '🚀 LIVE — applique les changements en DB')
const r = backfillRefundsToFactures({ dryRun })
console.log('\n=== Résumé ===')
console.log(JSON.stringify({
  total_BTs: r.total,
  created: r.created,
  promoted_at_to_native: r.promoted,
  merged_dups: r.mergedDups,
  patched_doc_number: r.patched,
  skipped: r.skipped,
  unmatched_company: r.unmatched,
}, null, 2))
if (r.details?.length) {
  console.log('\n=== Détails (premiers 50) ===')
  for (const d of r.details) console.log(' ', JSON.stringify(d))
}
