#!/usr/bin/env node
// One-shot: delete all factures with sync_source='Remboursements Quickbooks'.
// Ces lignes proviennent d'Airtable (sync legacy) et n'ont aucun lien Stripe ni
// utilité métier dans l'ERP. La sync Airtable a été ajustée pour les ignorer.
//
// Usage :
//   node src/scripts/delete-qb-refunds.js            # dry run
//   node src/scripts/delete-qb-refunds.js --apply    # execute

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

const rows = db.prepare(
  "SELECT id, invoice_id, document_date, montant_avant_taxes FROM factures WHERE sync_source='Remboursements Quickbooks'"
).all()

console.log(`Remboursements QuickBooks à supprimer: ${rows.length}`)
for (const r of rows) {
  console.log(` - ${r.id} | invoice_id=${r.invoice_id} | date=${r.document_date} | avant taxes=${r.montant_avant_taxes}`)
}

if (!rows.length) {
  console.log('Rien à faire.')
  process.exit(0)
}

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour supprimer.')
  process.exit(0)
}

const res = db.prepare("DELETE FROM factures WHERE sync_source='Remboursements Quickbooks'").run()
console.log(`\n✅ Supprimé ${res.changes} ligne(s).`)
