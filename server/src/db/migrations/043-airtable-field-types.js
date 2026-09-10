/**
 * 043 — Cache du TYPE Airtable de chaque champ, par base/table.
 *
 * Pourquoi. Un champ Airtable de type FORMULE (et de même rollup, lookup,
 * count, autoNumber, « créé le / modifié par », bouton…) est calculé par
 * Airtable : l'API refuse toute écriture dessus (422). Boréal proposait
 * pourtant le sens « Bidirectionnel » / « Boréal → Airtable » sur ces
 * champs-là — le write-back partait et échouait, silencieusement pour
 * l'utilisateur qui avait fait le réglage.
 *
 * La liste des champs non écrivables était tenue À LA MAIN, module par module
 * (`neverPush` dans services/airtableWriteback.js : « Statut » et « # de
 * commande » des commandes, « Pays » des envois, « Coût unitaire actuel » des
 * lignes). Toute autre formule mappée depuis /champs/:table passait au travers.
 *
 * Ce que la table apporte. Le type de chaque champ est déjà connu à chaque
 * lecture des métadonnées Airtable (`/meta/bases/:id/tables`) — page des
 * champs, modale de mapping cœur, passe de sync dynamique. On le PERSISTE ici
 * pour qu'il soit lisible SYNCHRONEMENT, sans appel réseau, par les chemins qui
 * en ont besoin : le sélecteur de sens, la garde de `setFieldDirection` et la
 * construction du payload de write-back.
 *
 * Cache, pas source de vérité : une entrée absente ne bloque rien (le
 * comportement retombe sur l'ancien), et chaque passe de sync la rafraîchit.
 */
import db from '../database.js'

export const id = '043-airtable-field-types'
export const description =
  'airtable_field_types — type Airtable de chaque champ (formule, rollup…), pour interdire le write-back sur les champs calculés'

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS airtable_field_types (
      base_id    TEXT NOT NULL,
      table_id   TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_id   TEXT,
      field_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (base_id, table_id, field_name)
    )
  `)
  return { created: 'airtable_field_types' }
}
