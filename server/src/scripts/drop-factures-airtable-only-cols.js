#!/usr/bin/env node
// One-shot: supprime les colonnes de factures qui ne sont plus remplies par
// personne depuis la déconnexion du sync Airtable (les "Airtable-only"), et
// nettoie les airtable_field_defs correspondants.
//
// Colonnes canoniques (DDL schema.js) + colonnes hybrides (écrites par le
// webhook Stripe) sont conservées. Seules les colonnes purement issues
// d'Airtable (formules, rollups, liens QB, champs inutilisés) sont droppées.
//
// Usage :
//   node src/scripts/drop-factures-airtable-only-cols.js            # dry run
//   node src/scripts/drop-factures-airtable-only-cols.js --apply    # execute

import Database from 'better-sqlite3'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')

const db = new Database(DB_PATH)

const COLUMNS = [
  // Calculs / formules Airtable
  'proposition', 'annee_fiscale_de_la_facture', 'periode', 'month',
  'conversion_rate', 'taux_de_change', 'estimation_de_cout_de_pieces',
  'nombre_de_factures_de_l_abonnement',
  'nombre_de_projets_avec_commandes_a_envoyer',
  'commande_directes_a_envoyer',
  // Rollups / linked records Airtable
  'client_final', 'numero_de_projet', 'retours', 'commandes', 'commande',
  'soumissions', 'abonnement', 'depot', 'rachat', 'products', 'productsids',
  'produit_site_web', 'adresse_de_la_ferme_from_projet', 'facture_a_recuperer',
  // Liens QuickBooks (remplaçable par le UI QB direct au besoin)
  'lien', 'customer_link',
  // Champs Airtable divers / inutilisés
  'event_history', 'last_update', 'invoice_pdf', 'source_record_link',
  'recordid', 'type', 'pays_de_livraison_du_client_final',
  'province_de_livraison_du_client_final', 'region_usa',
  'afficher_les_informations_detaillees',
]

// Verify all columns currently exist
const existingCols = new Set(db.prepare('PRAGMA table_info(factures)').all().map(c => c.name))
const missing = COLUMNS.filter(c => !existingCols.has(c))
const present = COLUMNS.filter(c => existingCols.has(c))

console.log(`Colonnes cibles : ${COLUMNS.length}`)
console.log(`  présentes en DB (à dropper) : ${present.length}`)
console.log(`  déjà absentes                : ${missing.length}${missing.length ? ' — ' + missing.join(', ') : ''}`)

// Compte de données non-null par colonne, pour visibilité
console.log('\nContenu actuel (non-null count) :')
for (const c of present) {
  const q = db.prepare(`SELECT COUNT(*) as n FROM factures WHERE ${c} IS NOT NULL AND ${c} != ''`).get()
  console.log(`  ${c.padEnd(48)} ${q.n}`)
}

// Also list the airtable_field_defs rows that will be cleaned
const defs = db.prepare(
  `SELECT column_name FROM airtable_field_defs WHERE erp_table='factures' AND column_name IN (${present.map(() => '?').join(',')})`
).all(...present)
console.log(`\nairtable_field_defs à supprimer : ${defs.length}`)

if (!APPLY) {
  console.log('\nDry run (aucune modification). Relance avec --apply pour appliquer.')
  process.exit(0)
}

// Apply: drop each column in a transaction
const tx = db.transaction(() => {
  for (const c of present) {
    db.exec(`ALTER TABLE factures DROP COLUMN ${c}`)
  }
  if (defs.length) {
    const del = db.prepare(
      `DELETE FROM airtable_field_defs WHERE erp_table='factures' AND column_name IN (${present.map(() => '?').join(',')})`
    )
    del.run(...present)
  }
})
tx()

const remaining = db.prepare('PRAGMA table_info(factures)').all().length
console.log(`\n✅ ${present.length} colonne(s) droppée(s) + ${defs.length} field_def(s) nettoyé(s). Reste ${remaining} colonnes dans factures.`)
