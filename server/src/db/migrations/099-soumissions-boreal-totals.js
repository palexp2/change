/**
 * 099 — Soumissions créées dans Boréal : prix achat / prix abo.
 *
 * Seules les soumissions Airtable recevaient purchase_price / subscription_price
 * (du miroir) ; celles créées dans Boréal restaient à 0 $ dans les listes
 * (fiche Projet, /soumissions). La création/modification les enregistre
 * désormais ; ceci rattrape les existantes. Seulement celles qui ont des
 * lignes : une soumission legacy sans ligne garde le prix qu'on lui a donné.
 */
import { storeSoumissionTotals } from '../../services/soumissionTotals.js'

export const id = '099-soumissions-boreal-totals'
export const description = 'Soumissions Boréal : prix achat / abo calculés depuis leurs lignes'

export function up(db) {
  const ids = db.prepare(`
    SELECT s.id FROM soumissions s
    WHERE s.airtable_id IS NULL
      AND EXISTS (SELECT 1 FROM document_items di WHERE di.document_id = s.id AND di.document_type = 'soumission')
  `).all().map(r => r.id)
  for (const sid of ids) storeSoumissionTotals(db, sid)
}
