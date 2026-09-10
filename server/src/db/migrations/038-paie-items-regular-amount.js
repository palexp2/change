/**
 * 038 — `paie_items.regular_amount` : colonne GÉNÉRÉE (heures régulières × taux).
 *
 * Prépare la conversion du champ « $ heures rég. » des paies en vrai champ
 * personnalisé. Ce total était une sous-requête recopiée dans les routes
 * (`SUM(regular_hours * hourly_rate)`), et un rollup ne sait agréger qu'UNE
 * colonne — pas un produit. La multiplication descend donc d'un cran, là où
 * elle a un sens métier : le montant des heures régulières d'une ligne de paie.
 *
 * `GENERATED ALWAYS … VIRTUAL` = rien n'est stocké ni à maintenir, SQLite
 * recalcule à la lecture ; le sync Airtable et les routes qui écrivent
 * `paie_items` ne changent pas d'un caractère (une colonne générée n'accepte
 * pas d'écriture, et aucun INSERT ne la nomme). C'est aussi la seule forme
 * qu'`ALTER TABLE ADD COLUMN` accepte — STORED est refusé.
 *
 * À savoir : `PRAGMA table_info` n'énumère PAS les colonnes générées, seul
 * `table_xinfo` les voit (cf. `childColumns()` dans services/customFieldsView.js,
 * sans quoi le rollup serait refusé « colonne introuvable »).
 */
import db from '../database.js'

export const id = '038-paie-items-regular-amount'
export const description =
  'paie_items.regular_amount (colonne générée) — support du rollup « $ heures rég. » des paies'

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma('table_xinfo(paie_items)').map(c => c.name))
  if (cols.has('regular_amount')) return { skipped: 'colonne déjà présente' }

  d.exec(`
    ALTER TABLE paie_items ADD COLUMN regular_amount REAL
      GENERATED ALWAYS AS (COALESCE(regular_hours, 0) * COALESCE(hourly_rate, 0)) VIRTUAL
  `)

  return { added: 'paie_items.regular_amount' }
}
