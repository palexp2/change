#!/usr/bin/env node
// One-shot backfill : pose project_id / order_id sur les factures ERP non liées,
// en allant chercher les liens Projet/Commande dans Airtable.
//
// Règles (voir services/factureLinks.js pour le détail) :
//   - Une facture ERP n'est touchée que si :
//       project_id IS NULL AND order_id IS NULL AND invoice_id LIKE 'in_%'
//     (preuve qu'elle existe côté Stripe — on n'importe rien d'Airtable
//     qui ne soit pas confirmé Stripe).
//   - Match Airtable ↔ ERP via document_number = Numéro de document.
//   - Aucun INSERT, aucune autre colonne touchée.
//
// Usage :
//   node src/scripts/backfill-factures-airtable-links.js              # dry run
//   node src/scripts/backfill-factures-airtable-links.js --apply      # exécute

import { backfillFactureLinks } from '../services/factureLinks.js'

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(APPLY ? '🚀 Mode APPLY — écritures activées' : '🔍 Dry run — relance avec --apply pour appliquer')
  const t0 = Date.now()
  const result = await backfillFactureLinks({ apply: APPLY })

  console.log(`\n--- Résultat (${Date.now() - t0} ms) ---`)
  const { actions, ...counts } = result
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)

  if (actions?.length) {
    console.log(`\n--- Actions (${APPLY ? 'effectuées' : 'prévues'}) ---`)
    for (const a of actions) console.log(`  • ${a.doc}  →  ${a.action}  (${a.factureId})`)
  }

  console.log(APPLY ? '\n✅ Modifications appliquées.' : '\n⚠️  Dry run — relance avec --apply pour appliquer.')
  process.exit(0)
}

main().catch(e => {
  console.error('❌ Échec :', e)
  process.exit(1)
})
