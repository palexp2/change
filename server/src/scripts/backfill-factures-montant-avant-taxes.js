#!/usr/bin/env node
// One-shot: copie amount_before_tax_cad vers montant_avant_taxes pour les factures
// où ce champ natif (en devise de la facture) est NULL. Concerne principalement
// les factures et remboursements créés par les webhooks/queue Stripe (qui ne
// remplissaient pas cette colonne, contrairement à l'ancien sync Airtable).
//
// Note: dans ce code base, amount_before_tax_cad contient historiquement la
// valeur en devise native pour les records créés par Stripe (pas réellement
// convertie en CAD — quirk hérité). La copie directe est donc correcte.
//
// Usage :
//   node src/scripts/backfill-factures-montant-avant-taxes.js            # dry run
//   node src/scripts/backfill-factures-montant-avant-taxes.js --apply    # execute

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

const rows = db.prepare(`
  SELECT id, sync_source, status, currency, amount_before_tax_cad
  FROM factures
  WHERE amount_before_tax_cad != 0 AND montant_avant_taxes IS NULL
`).all()

console.log(`Factures à backfiller (amount_before_tax_cad != 0 AND montant_avant_taxes IS NULL): ${rows.length}`)

const bySource = {}
for (const r of rows) {
  const k = `${r.sync_source || '(null)'} / ${r.status} / ${r.currency}`
  bySource[k] = (bySource[k] || 0) + 1
}
console.log('Répartition:')
for (const [k, n] of Object.entries(bySource)) console.log(`  ${k}: ${n}`)

if (!rows.length) {
  console.log('Rien à faire.')
  process.exit(0)
}

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour appliquer.')
  process.exit(0)
}

const upd = db.prepare(
  `UPDATE factures SET montant_avant_taxes = CAST(amount_before_tax_cad AS TEXT),
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = ? AND montant_avant_taxes IS NULL`
)
let updated = 0
const tx = db.transaction((list) => {
  for (const r of list) {
    const res = upd.run(r.id)
    if (res.changes) updated++
  }
})
tx(rows)
console.log(`\n✅ ${updated} facture(s) backfillée(s).`)
