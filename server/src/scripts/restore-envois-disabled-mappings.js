#!/usr/bin/env node
// Réparation one-shot : rétablit les tombstones de mapping Airtable des envois.
//
// drop-envois-airtable-only-cols.js supprimait les lignes airtable_field_mappings
// des champs droppés. Or c'est cette ligne, avec import_disabled=1, qui marque un
// champ Airtable comme « désactivé » dans la modale de sync (Connecteurs →
// Airtable → Envois → champs). Sans elle, les 38 champs se réaffichaient comme
// disponibles à l'import — l'impression qu'ils étaient revenus.
//
// La route de désactivation ne sait poser qu'un seul tombstone par table
// (column_name='__pending__', UNIQUE(erp_table, column_name)) : on rétablit donc
// la ligne d'origine, avec son ancien nom de colonne. Rien ne lit cette colonne —
// elle n'existe plus et l'import est coupé — elle ne sert qu'à porter le « non,
// on n'importe pas ce champ ».
//
//   node src/scripts/restore-envois-disabled-mappings.js            # dry run
//   node src/scripts/restore-envois-disabled-mappings.js --apply

import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'

const DB_PATH = process.env.DB_PATH || './data/erp.db'
const APPLY = process.argv.includes('--apply')
const db = new Database(DB_PATH)

// colonne ERP droppée → nom ACTUEL du champ Airtable (la modale apparie par nom ;
// « Poids (lbs) » a été renommé « Poids total (lbs) » côté Airtable depuis).
// `adresse_de_livraison` est volontairement absent : son champ Airtable
// « Adresse de livraison » est déjà mappé, actif, vers address_id — lui rendre un
// doublon désactivé ferait passer le mapping vivant pour désactivé.
const PAIRS = [
  ['adresse_de_depart', 'Adresse de départ'],
  ['autonumber', 'Autonumber'],
  ['boites', 'Boites'],
  ['client_final_from_commande_lie', 'Client final (from Commande lié)'],
  ['commande', 'Commande'],
  ['confirmation_pickup', 'Confirmation pickup'],
  ['courriel', 'Courriel'],
  ['cout_total_des_pieces', 'Coût total des pièces'],
  ['date_de_ramassage', 'Date de ramassage'],
  ['documents', 'Documents'],
  ['employe', 'Employé'],
  ['entreprise', 'Entreprise'],
  ['etiquette_d_expedition', "Étiquette d'expédition"],
  ['feedback_message', 'Feedback message'],
  ['heure_de_debut_ramassage', 'Heure de début ramassage'],
  ['heure_de_fin_ramassage', 'Heure de fin ramassage'],
  ['infos_destinataire', 'Infos destinataire'],
  ['infos_expediteur', 'Infos expéditeur'],
  ['langue_de_correspondance', 'Langue de correspondance'],
  ['lien_tracking', 'Lien tracking'],
  ['liens_documents_d_envois', "Liens documents d'envois"],
  ['nom_du_contact_from_adresse', 'Nom du contact (from adresse)'],
  ['nombre_de_boites_sans_poids_indique', 'Nombre de boites sans poids indiqué'],
  ['originalinvoicedate', 'originalInvoiceDate'],
  ['originalinvoicenumber', 'originalInvoiceNumber'],
  ['pickup', 'Pickup'],
  ['pickup_id', 'Pickup Id'],
  ['poids_des_boites_non_indique', 'Poids des boites non indiqué'],
  ['poids_indique_des_boites', 'Poids indiqué des boites'],
  ['poids_lbs', 'Poids total (lbs)'],
  ['recordid', 'recordId'],
  ['retour', 'Retour'],
  ['service_d_etiquettes', "Service d'étiquettes"],
  ['shipment_rates', 'Shipment rates'],
  ['shipping_id_novoxpress', 'Shipping ID Novoxpress'],
  ['somme_de_poids_de_boites', 'Somme de poids de boites'],
  ['type_d_items', "Type d'items"],
  ['valeur_de_retour_declaree', 'Valeur de retour déclarée'],
]

const existing = new Set(
  db.prepare("SELECT column_name FROM airtable_field_mappings WHERE erp_table='shipments'").all().map(r => r.column_name)
)
const todo = PAIRS.filter(([col]) => !existing.has(col))
const stray = db.prepare(
  "SELECT id, airtable_field_name FROM airtable_field_mappings WHERE erp_table='shipments' AND column_name='__pending__'"
).all()

console.log(`tombstones à rétablir : ${todo.length}/${PAIRS.length}`)
console.log(`tombstones '__pending__' à retirer : ${stray.length}${stray.length ? ' — ' + stray.map(s => s.airtable_field_name).join(', ') : ''}`)
if (!APPLY) { console.log("\nDry run. Relance avec --apply."); process.exit(0) }

db.transaction(() => {
  for (const s of stray) db.prepare('DELETE FROM airtable_field_mappings WHERE id=?').run(s.id)
  const ins = db.prepare(`
    INSERT INTO airtable_field_mappings
      (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, options, sort_order, import_disabled)
    VALUES (?, 'envois', 'shipments', ?, ?, ?, '{}', 0, 1)
  `)
  for (const [col, name] of todo) ins.run(uuid(), `retired_${col}`, name, col)
})()

console.log(`\n✅ ${todo.length} champ(s) Airtable remis à « désactivé ».`)
