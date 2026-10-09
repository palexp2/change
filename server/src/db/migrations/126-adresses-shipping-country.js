/**
 * 126 — `adresses.shipping_country` : colonne GÉNÉRÉE (pays des adresses de livraison).
 *
 * Support du champ « Pays de livraison » des entreprises (rollup ARRAYUNIQUE
 * `companies.shipping_country`, cf. nativeFieldConversions.js). Un rollup ne
 * filtre pas les lignes liées : le filtre « type = Livraison » descend donc
 * dans la table enfant, comme `paie_items.regular_amount` (migration 038).
 *
 * L'ancienne colonne `companies.pays_de_livraison` (lookup Airtable, import
 * coupé, champ purgé le 2026-09-24) n'est pas réutilisée : figée, et sous
 * pierre tombale dans `purged_fields`.
 *
 * Pays normalisé en code ISO (le formulaire d'adresse écrit CA/US, quelques
 * lignes anciennes portent « Canada »).
 */
import db from '../database.js'

export const id = '126-adresses-shipping-country'
export const description =
  'adresses.shipping_country (colonne générée) — support du champ « Pays de livraison » des entreprises'

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = new Set(d.pragma('table_xinfo(adresses)').map(c => c.name))
  if (cols.has('shipping_country')) return { skipped: 'colonne déjà présente' }

  d.exec(`
    ALTER TABLE adresses ADD COLUMN shipping_country TEXT
      GENERATED ALWAYS AS (CASE WHEN address_type = 'Livraison' THEN
        CASE upper(trim(country))
          WHEN 'CANADA' THEN 'CA'
          WHEN 'USA' THEN 'US'
          WHEN 'UNITED STATES' THEN 'US'
          WHEN 'ÉTATS-UNIS' THEN 'US'
          ELSE nullif(trim(country), '')
        END
      END) VIRTUAL
  `)

  return { added: 'adresses.shipping_country' }
}
