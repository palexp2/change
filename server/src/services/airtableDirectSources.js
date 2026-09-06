import { COMMISSION_AIRTABLE_FIELDS } from './projectCommissions.js'

// ── Tables lues EN DIRECT dans Airtable ────────────────────────────────────
//
// Quelques tables affichées dans Boréal ne sont pas miroitées : on va lire
// Airtable au moment de l'affichage, rien n'est stocké ni écrit, et le champ
// Airtable qui alimente chaque colonne est fixé dans le code du lecteur.
//
// Ces tables n'ont donc ni module Airtable ni mapping en base — d'où l'absence
// totale de colonne « Champ Airtable » sur leur page /champs, qui laissait
// croire que le mapping avait disparu. Ce registre permet de l'afficher quand
// même, en lecture seule, avec la raison.
export const AIRTABLE_DIRECT_SOURCES = {
  project_commissions: {
    label: 'Commissions',
    reason: 'Lue en direct dans Airtable (hors miroir) — mapping fixé en code.',
    fields: COMMISSION_AIRTABLE_FIELDS,
  },
}

export function directSourceFor(table) {
  const src = AIRTABLE_DIRECT_SOURCES[table]
  if (!src) return null
  return { table, label: src.label, reason: src.reason, fields: src.fields }
}
