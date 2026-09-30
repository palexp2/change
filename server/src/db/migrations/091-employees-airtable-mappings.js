/**
 * 091 — Employés : rétablir le mapping Airtable des 27 champs du miroir.
 *
 * Le retrait du field_map « cœur » des employés devait recopier ses noms de
 * champs dans airtable_field_mappings. Mais un UPDATE de schema.js remettait ce
 * field_map à NULL à chaque démarrage : il n'y avait plus rien à reprendre.
 * Résultat : /champs/employees sans aucun champ Airtable, et un miroir qui
 * sautait les 34 employés (ni prénom ni nom mappés). L'UPDATE est retiré ; on
 * pose ici les correspondances, relevées dans la table Airtable « Employés ».
 *
 * Une colonne déjà mappée par l'utilisateur n'est jamais touchée.
 */
import { newRecordId } from '../../utils/recordId.js'

export const id = '091-employees-airtable-mappings'
export const description = 'employees : rétablit les 27 mappings Airtable perdus (Prénom, Nom, Courriels…)'

const MAPPINGS = [
  ['first_name', 'fldJlbsmHGCltzeAp', 'Prénom'],
  ['last_name', 'flddvLjZ9SqoaYwz0', 'Nom'],
  ['email_work', 'fldwAtqLB37qYwfgt', 'Courriel professionnel'],
  ['email_personal', 'fldt4msLHEDSDv0dW', 'Courriel personnel'],
  ['phone_work', 'fld5ZIR6XnwN5vr44', 'Téléphone travail'],
  ['phone_personal', 'fldul2BILMpCSRtRg', 'Téléphone perso'],
  ['birth_date', 'fldtjdDu8K8g1LMdt', 'Date de naissance'],
  ['hire_date', 'fld9qzULJD6WGoyw7', "Date d'embauche"],
  ['matricule', 'fldk5NDMfwaVKFj1c', 'Matricule Nethris'],
  ['active', 'fldPa65P1plfqPXwW', 'Actif'],
  ['gender', 'fldF3BvUecodTYRq5', 'Genre'],
  ['address', 'fldfq0UKW0U25JZKE', 'Adresse de résidence'],
  ['emergency_contact', 'fldh7SQI40k46AjEC', "Contact en cas d'urgence"],
  ['end_date', 'fldq7PFbc0i3ipLYh', "Date de fin d'emploi"],
  ['office_key', 'fldPb8bsWtp586sxB', 'Clef du bureau'],
  ['insurance_id', 'fldUNjSOpobUpUXVU', 'ID Assurances'],
  ['nethris_username', 'fldDbyJzNiykPITcK', 'Nethris username'],
  ['is_salesperson', 'fldggnLyxEOY7MgAn', 'Vendeur'],
  ['is_consultant', 'fldoIMEHtOpywW15C', 'Consultant'],
  ['accounting_department', 'fldNmuhrhbJEkpApR', 'Département pour comptabilité'],
  ['hours_per_week', 'fldBc96wr9iznsz5I', 'Heures par semaine'],
  ['last_raise_date', 'fldmTbSSzTwWEIcE4', 'Dernière augmentation'],
  ['group_insurance', 'flddrNMVfxbu8lFQ7', 'Assurance collective'],
  ['address_verified', 'fldsuA0LSBMHrYlrO', 'Validation adresse'],
  ['banking_info', 'fldFIAhOzarfB3Y1o', 'Coordonnées bancaires'],
  ['issues', 'fld67NnOIDtCdCEuz', 'Problèmes'],
  ['peer_reviews', 'fldZ2Y1OHI0QffDqV', 'Évaluations par les pairs'],
]

export function up(db) {
  const liveCols = new Set(db.prepare('PRAGMA table_info(employees)').all().map(c => c.name))
  const taken = new Set(db.prepare(
    "SELECT column_name FROM airtable_field_mappings WHERE erp_table='employees'"
  ).all().map(r => r.column_name))
  const insert = db.prepare(`
    INSERT INTO airtable_field_mappings (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, sort_order)
    VALUES (?, 'employees', 'employees', ?, ?, ?, '{}', 0)
  `)
  let inserted = 0
  for (const [column, fieldId, name] of MAPPINGS) {
    if (!liveCols.has(column) || taken.has(column)) continue
    insert.run(newRecordId(), fieldId, name, column)
    inserted++
  }
  return { inserted }
}
