#!/usr/bin/env node
// One-shot: pour toute facture avec company_id NULL mais customer_id présent,
// tente de trouver la company correspondante via companies.stripe_customer_id
// et remplit company_id. Concerne les factures importées historiquement depuis
// Airtable qui avaient le Stripe customer mais pas le lien entreprise.
//
// Usage :
//   node src/scripts/backfill-factures-company-from-stripe.js            # dry run
//   node src/scripts/backfill-factures-company-from-stripe.js --apply    # execute

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

const rows = db.prepare(`
  SELECT f.id, f.invoice_id, f.customer_id, f.status, f.document_date, f.sync_source,
         c.id AS matched_company_id, c.name AS matched_company_name
  FROM factures f
  JOIN companies c ON c.stripe_customer_id = f.customer_id
  WHERE f.company_id IS NULL AND f.customer_id IS NOT NULL
`).all()

console.log(`Factures matchables (company_id NULL → stripe_customer_id → company): ${rows.length}`)

// Recap par sync_source
const bySource = {}
for (const r of rows) {
  const k = r.sync_source || '(null)'
  bySource[k] = (bySource[k] || 0) + 1
}
console.log('Répartition par sync_source:')
for (const [src, n] of Object.entries(bySource)) console.log(`  ${src}: ${n}`)

// Petit échantillon
console.log('\nÉchantillon (10 premières):')
for (const r of rows.slice(0, 10)) {
  console.log(` - ${r.id} | ${r.sync_source} | ${r.status} | inv=${r.invoice_id} | cust=${r.customer_id} → ${r.matched_company_name}`)
}

if (!rows.length) {
  console.log('\nRien à faire.')
  process.exit(0)
}

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour appliquer.')
  process.exit(0)
}

const upd = db.prepare(`UPDATE factures SET company_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND company_id IS NULL`)
let updated = 0
const tx = db.transaction((list) => {
  for (const r of list) {
    const res = upd.run(r.matched_company_id, r.id)
    if (res.changes) updated++
  }
})
tx(rows)
console.log(`\n✅ ${updated} facture(s) liée(s) à leur company via stripe_customer_id.`)
