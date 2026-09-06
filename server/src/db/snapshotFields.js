// ─── Champs supprimés : hors du snapshot ──────────────────────────────────────
//
// Supprimer un champ retire sa DÉFINITION (ligne `custom_fields` soft-supprimée,
// ou pierre tombale dans `purged_fields`) mais laisse la colonne SQL en place —
// des routes, des syncs et des automatisations la lisent encore, on ne peut pas
// la dropper (voir services/fieldPurge.js). Le snapshot, lui, n'a aucune raison
// de la transporter : le portier de champs la masque partout côté client.
//
// L'enjeu est le volume. Au 2026-09-03 : 28 % du snapshot (17,8 Mo sur 63) était
// constitué de colonnes de champs supprimés — `contacts` à lui seul envoyait
// 13,6 Mo de champs que plus personne n'affiche, sur 17,1 Mo.
//
// L'EXCEPTION qui rend la règle sûre : une page peut lire la colonne EN DUR sur un
// record du cache, hors du portier — un tri, un repli de libellé, un calcul. Le
// portier ne couvre que l'affichage piloté par les champs, pas ce code-là. Ces
// colonnes restent dans le snapshot, listées ci-dessous avec la raison.
//
// Le périmètre du risque est petit et connu : seules les pages qui lisent le cache
// (`useTable` / `getRecord`) peuvent casser. Tout le reste de l'app est servi par
// l'API, où la colonne SQL n'a pas bougé. Le test `snapshotFields.guard.test.js`
// vérifie exactement ça — il relit ces fichiers-là et échoue si une colonne exclue
// y est encore nommée.
const SNAPSHOT_KEEP = {
  // `date_commande` : Priorité d'assemblage l'affiche sur ses cartes et trie
  // dessus — hors tableau, donc hors portier (pages/PrioriteAssemblage.jsx).
  // `autonumber` : libellé de repli d'une commande sans numéro dans la liste des
  // records récents (lib/useRecentRecords.js, labelFor).
  orders: ['autonumber', 'date_commande'],
  // La liste des commandes calcule la semaine d'expédition à partir des envois du
  // cache (dernier `shipped_at` par commande). Voir pages/Orders.jsx.
  shipments: ['shipped_at'],
}

// Colonnes dont le NOM apparaît dans un fichier du cache, vérifié à la main comme
// ne concernant pas ce record-là : un mot français d'un commentaire (« au lieu de »,
// « commande », « mois »), une variable locale (`today`, `serials`), ou la même
// colonne lue sur une AUTRE table (`row.company_name` d'une commande, `row.status`
// d'une tâche). Elles sortent donc du snapshot malgré la collision de nom.
//
// Cette liste n'existe que pour le test de garde : elle dit « ce cas a été
// examiné ». Une NOUVELLE suppression dont le nom entre en collision fera échouer
// le test tant que personne ne l'aura tranchée — c'est tout l'intérêt.
const SNAPSHOT_REVIEWED = {
  // `soumissions` / `soumission` : noms de TABLES dans la carte entité → table
  // du pont temps réel (lib/recordLive.jsx), pas des colonnes lues sur une
  // entreprise ou un projet.
  companies: ['company_name', 'created', 'instagram', 'lieu', 'mois', 'soumissions'],
  // `contacts.company_name` : la liste des contacts la nomme (repli de libellé),
  // mais la table n'a PAS cette colonne — le nom est joint depuis `company_id`.
  // Rien à envoyer, donc rien à garder.
  contacts: ['company_name', 'mois', 'today'],
  order_items: ['actions', 'autonumber', 'entreprise', 'lieu', 'product_name', 'serials'],
  // `orders.signature` : le nom n'apparaît que comme variable locale
  // (useRecordLinks) et dans l'analyseur de courriels — jamais sur une commande.
  // `address_id` : nommé par le champ « Adresse de livraison » du formulaire de
  // CRÉATION (pages/Orders.jsx) — un nom de champ posté à l'API, jamais lu sur
  // une commande du cache. Le picker de la fiche passe par l'API.
  // `assigned_name` : le champ « Assigné à » des commandes a été supprimé et ses
  // deux lectures retirées (fiche + liste) ; le nom ne subsiste que pour les
  // TÂCHES et les BILLETS, qui ont leur propre colonne.
  // `documents`, `signature`, `types` retirés de cette liste le 2026-09-03 : les
  // colonnes elles-mêmes sont détruites (drop-orders-airtable-only-cols.js),
  // il n'y a plus de cas à examiner.
  orders: ['address_id', 'assigned_name'],
  projects: ['annule', 'autonumber', 'orders', 'soumission', 'version'],
  shipments: ['commande', 'company_name', 'order_number', 'shipping_id_novoxpress', 'status'],
  tickets: ['mois', 'semaine'],
}

// Colonnes de structure : jamais retirées du snapshot, quoi qu'il arrive à leur
// champ. Le cache client s'en sert pour identifier, dater et supprimer ses rows.
const STRUCTURAL_COLUMNS = new Set(['id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at'])

// Une colonne reste-t-elle dans le snapshot malgré la suppression de son champ ?
export function isSnapshotKept(tableName, column, idColumn = 'id') {
  if (column === idColumn) return true
  if (STRUCTURAL_COLUMNS.has(column)) return true
  return !!SNAPSHOT_KEEP[tableName]?.includes(column)
}

export { SNAPSHOT_KEEP, SNAPSHOT_REVIEWED, STRUCTURAL_COLUMNS }
