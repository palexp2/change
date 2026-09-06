/**
 * 027 — « Contact » (Retours) : le natif meurt, un champ personnalisé le remplace.
 *
 * Demande : « supprime le champ contact codé en dur, drop column », puis, une
 * fois les conséquences mesurées : « convertir en champ personnalisé et
 * rattacher les fils à ce champ ».
 *
 * Pourquoi la conversion et pas la suppression sèche. `returns.contact_id`
 * n'était pas un champ d'affichage : 403 des 476 retours le portent, et c'est
 * LUI qui répond à quatre questions du domaine —
 *   1. où renvoyer le colis (3ᵉ niveau de la cascade d'adresses,
 *      services/returnContext.js) : les niveaux 1 et 2 (envoi lié, commande
 *      liée) ne se déclenchent JAMAIS sur les données réelles, et 386 retours
 *      n'ont aucune adresse d'entreprise en repli. Le supprimer laissait donc
 *      81 % des retours sans adresse d'étiquette ;
 *   2. qui relancer pour un échange immédiat (services/returnExchangeReminder.js) ;
 *   3. en quelle langue écrire le mémo et les instructions (routes/retours.js) ;
 *   4. à quel contact rattacher l'interaction de l'envoi d'instructions.
 * La donnée reste donc intégralement en place — elle change simplement de
 * porteur, et les quatre fils sont rebranchés sur la colonne d'accueil.
 *
 * D'où vient la donnée. « Contact » (fldMVU97kJLsw9Ewx) est un champ lié
 * Airtable, tiré par le field_map « cœur » du miroir `retours`
 * (CORE_PLANS.retours dans services/airtableMirrorEngine.js) via la
 * transformation `link_contact` — laquelle résout le record ID Airtable en id
 * de contact ERP. Le champ reste donc en import seul (`kind:'data'`,
 * `source:'airtable'`), comme `n_de_retour` en 026 : le plan cœur est repointé
 * sur la colonne survivante dans le même mouvement, sans quoi le sync suivant
 * écrirait dans une colonne disparue.
 *
 * Pourquoi la colonne d'accueil porte une clé étrangère. C'est elle que lit
 * `recordLinkTargetOf()` (services/customFieldsView.js) pour dire vers quelle
 * table pointent les valeurs — donc pour rendre le champ en pastille cliquable
 * plutôt qu'en identifiant brut, comme l'exige la règle « champs référence » du
 * CLAUDE.md. La détection FK ne servait jusqu'ici qu'aux lookups : le GET des
 * champs perso (routes/custom-fields.js) l'applique désormais aussi aux champs
 * `data`, sans quoi la déclaration ne produirait rien à l'écran.
 *
 * Ordre d'opérations (cf. 023 / 025 / 026) :
 *   1. création de la colonne d'accueil `contact` (slug du libellé, comme les
 *      38 autres champs Airtable de la table) et report des valeurs ;
 *   2. garde-fou : on ne DROP que si le report est complet — un lien perdu ici
 *      est un colis qu'on ne sait plus où renvoyer ;
 *   3. ligne `custom_fields` qui prend possession de la colonne ;
 *   4. DROP VIEW returns_v — SQLite refuse le DROP COLUMN tant qu'une vue
 *      référence la table ;
 *   5. ALTER TABLE returns DROP COLUMN contact_id ;
 *   6. registres qui décrivaient le natif ;
 *   7. `airtable_field_map` repointé : le champ Airtable reste mis en miroir,
 *      simplement vers `contact` ;
 *   8. regenerateView('returns').
 *
 * Pas de reprise des vues enregistrées (contrairement à 026) : `contact_id`
 * n'a jamais eu de ligne dans `tableDefs.js` ni dans `custom_fields`, il ne
 * pouvait donc être ni une colonne de la table `/retours`, ni un tri, ni un
 * filtre. Vérifié en base avant écriture : zéro `table_view_pills`, zéro
 * `table_view_configs`, zéro `detail_field_configs`, zéro automatisation.
 *
 * Pas de `purged_fields` non plus : le champ n'est pas supprimé, il change de
 * porteur.
 *
 * Défensive : chaque garde-fou renvoie `skipped` au lieu de lever — une
 * exception arrêterait le démarrage du serveur.
 */
import db from '../database.js'
import { newRecordId } from '../../utils/recordId.js'
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '027-convert-returns-contact'
export const description = 'returns.contact_id droppée — « Contact » devient le champ personnalisé contact'

const TABLE = 'returns'
const OLD = 'contact_id'
const NEW = 'contact'
const LABEL = 'Contact'
const MIRROR = 'retours'

export function up(migrationDb) {
  const d = migrationDb || db

  const cols = () => new Set(d.pragma(`table_info(${TABLE})`).map(c => c.name))
  if (!cols().has(OLD)) return { skipped: 'colonne déjà absente' }

  // 1. Colonne d'accueil. Elle peut déjà exister si une exécution précédente
  // s'est arrêtée sur un garde-fou. La FK est portée par la colonne elle-même
  // (SQLite l'accepte sur un ADD COLUMN) : c'est elle qui rend le champ
  // cliquable vers la fiche du contact.
  if (!cols().has(NEW)) d.exec(`ALTER TABLE ${TABLE} ADD COLUMN [${NEW}] TEXT REFERENCES contacts(id)`)

  // Les deux colonnes se contredisent-elles ? Ce serait un arbitrage humain
  // (lequel des deux contacts garde-t-on ?), pas une conversion automatique.
  const { n: divergent } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE TRIM(COALESCE([${OLD}],'')) != ''
        AND TRIM(COALESCE([${NEW}],'')) != ''
        AND TRIM([${OLD}]) != TRIM([${NEW}])`
  ).get()
  if (divergent) return { skipped: `${divergent} retour(s) où les deux colonnes divergent — arbitrage manuel requis` }

  const carried = d.prepare(
    `UPDATE ${TABLE} SET [${NEW}] = TRIM([${OLD}])
      WHERE TRIM(COALESCE([${OLD}],'')) != '' AND TRIM(COALESCE([${NEW}],'')) = ''`
  ).run().changes

  // 2. On ne détruit la source qu'une fois la copie prouvée complète.
  const { n: unmoved } = d.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE}
      WHERE TRIM(COALESCE([${OLD}],'')) != '' AND TRIM(COALESCE([${NEW}],'')) = ''`
  ).get()
  if (unmoved) return { skipped: `${unmoved} lien(s) non reporté(s) — DROP annulé` }

  // 3. Le champ personnalisé qui prend possession de la colonne. `sort_order`
  // explicitement NULL : le DEFAULT 0 ferait remonter le champ en tête de
  // tableau. Une ligne déjà présente (rejeu, ou décision de l'utilisateur) est
  // laissée telle quelle.
  // La description n'est pas décorative : le champ est désormais supprimable
  // depuis /champs/retours, et sa suppression emporterait la colonne (purge de
  // la corbeille). Elle dit donc, à l'endroit exact où la décision se prend, ce
  // qui s'arrêterait.
  const DESCRIPTION = [
    'Contact du retour, importé du champ lié « Contact » d’Airtable (lecture seule).',
    'Quatre fonctions en dépendent : l’adresse proposée pour l’étiquette de retour',
    '(source principale — 386 retours sur 476), la relance courriel des échanges',
    'immédiats, la langue du mémo et des instructions, et le contact de',
    'l’interaction créée à l’envoi des instructions.',
  ].join(' ')
  const existing = d.prepare(
    `SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?`
  ).get(TABLE, NEW)
  let created = false
  if (!existing) {
    d.prepare(
      `INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind, source, sort_order, description)
       VALUES (?,?,?,?,'text','data','airtable',NULL,?)`
    ).run(newRecordId(), TABLE, LABEL, NEW, DESCRIPTION)
    created = true
  }

  // 4-5. Le natif disparaît.
  d.exec(`DROP VIEW IF EXISTS ${TABLE}_v`)
  d.exec(`ALTER TABLE ${TABLE} DROP COLUMN [${OLD}]`)

  // 6. Registres qui décrivaient le natif. Aucun n'a de ligne aujourd'hui
  // (le champ était cœur, donc hors du mapping champ-à-champ), mais une
  // migration qui suppose l'état de la base se trompe un jour.
  d.prepare(`DELETE FROM custom_fields WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  d.prepare(`DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  try {
    d.prepare(`DELETE FROM airtable_field_defs WHERE erp_table=? AND column_name=?`).run(TABLE, OLD)
  } catch { /* table héritée absente */ }

  // 7. Registre du miroir : même champ Airtable, colonne ERP enfin nommée (la
  // ligne cœur n'en portait aucune — la transformation vivait dans le code).
  const remapped = d.prepare(
    `UPDATE airtable_field_map SET erp_column=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE mirror_id=? AND core_key=? AND COALESCE(erp_column,'') IN ('', ?)`
  ).run(NEW, MIRROR, NEW, OLD).changes

  regenerateView(TABLE)

  return {
    dropped: `${TABLE}.${OLD}`, adopted: `${TABLE}.${NEW}`,
    carried_over: carried, custom_field_created: created, mirror_remapped: remapped,
  }
}
