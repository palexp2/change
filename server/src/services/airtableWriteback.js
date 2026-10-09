import db from '../db/database.js'
import { getAccessToken, airtablePatch, airtablePost } from '../connectors/airtable.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { logSync } from './syncLog.js'
import {
  COMPANIES_FIELD_MAP_PLAN, ENVOIS_FIELD_MAP_PLAN, ORDERS_FIELD_MAP_PLAN, PAIES_FIELD_MAP_PLAN, PIECES_FIELD_MAP_PLAN,
  PROJETS_FIELD_MAP_PLAN, RETOUR_ITEMS_FIELD_MAP_PLAN, SERIALS_FIELD_MAP_PLAN,
  fieldMapFromUi,
} from './airtableUiFieldMap.js'
import { nativeMappedColumn } from './airtableNativeMappedColumns.js'
import { computedAirtableFieldNames } from './airtableFieldTypes.js'
import { readRelation } from './customFieldsView.js'
import { erpTableForAirtableTableId } from './airtableTableMap.js'

// Résout l'airtable_id d'un record ERP lié (commande, adresse…) pour un linked record.
function linkedAirtableId(table, erpId) {
  if (!erpId) return null
  const r = db.prepare(`SELECT airtable_id FROM ${table} WHERE id=?`).get(erpId)
  return r?.airtable_id || null
}

// Forme d'un record ID Airtable — 'rec' + 14 caractères alphanumériques.
const REC_ID = /^rec[A-Za-z0-9]{14}$/

// Identifiants portés par une colonne lien. Deux formes coexistent selon la
// façon dont la colonne a été alimentée : un id Boréal nu (colonne FK, ex.
// `shipments.address_id`) ou un tableau JSON de clés (champ lien Airtable
// importé, cf. convertValue) — qui contient des record ids bruts quand le
// mapping n'a pas de table cible.
function linkKeys(raw) {
  if (raw == null || raw === '') return []
  let items = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('[')) { try { items = JSON.parse(s) } catch { items = s.split(',') } }
    else items = s.split(',')
  }
  if (!Array.isArray(items)) items = [items]
  return items.map(v => String(v ?? '').trim()).filter(Boolean)
}

// Valeur d'une colonne lien → tableau de record ids, la seule forme qu'un champ
// « linked record » d'Airtable accepte. `linkTable` est la table ERP où résoudre
// un id Boréal ; une clé qui est DÉJÀ un record id passe telle quelle (colonne
// miroir d'un champ lien mappé sans table cible).
//   []   → délier côté Airtable (la colonne ERP est vide)
//   null → intraduisible (référent sans jumeau Airtable) : l'appelant SAUTE le
//          champ, effacer le lien serait pire que ne rien faire.
// Exportée pour être testable sans appel réseau, comme airtableFieldValue.
export function airtableLinkIds(linkTable, raw) {
  const keys = linkKeys(raw)
  const ids = []
  for (const key of keys) {
    if (REC_ID.test(key)) { ids.push(key); continue }
    const linked = linkedAirtableId(linkTable, key)
    if (!linked) return null
    ids.push(linked)
  }
  return ids
}

// ── Write-back ERP → Airtable ────────────────────────────────────────────────
//
// Module pilote : « achats » (table ERP `purchases`). Quand un achat synchronisé
// depuis Airtable est édité dans l'ERP, on répercute la modification vers
// Airtable via PATCH. Une garde anti-boucle (airtable_writeback_guard) mémorise
// les valeurs poussées pour que le webhook de retour soit reconnu comme un echo
// et ignoré par le sync entrant (cf. consumeWritebackEcho dans syncAchats).
//
// Pour généraliser à d'autres modules : ajouter une entrée à WRITEBACK_MODULES
// (module Airtable ↔ table ERP) et déclencher writeBackRecord() sur l'édition.

export const WRITEBACK_MODULES = {
  achats: {
    erpTable: 'purchases',
    // Le field_map cœur des achats est vide depuis la migration 035 (toutes ses
    // colonnes ont été droppées) : il n'y a plus de clé à exclure ni à traduire
    // en colonne. Le write-back des achats passe donc entièrement par le chemin
    // DYNAMIQUE de buildColumnMap — les champs réglés dans /champs/purchases,
    // avec leur sens par champ (clé `dyn:<colonne>`).
    skipKeys: new Set(),
    keyToColumn: {},
  },
  envois: {
    erpTable: 'shipments',
    // Les envois n'ont plus de field_map en base : leur mapping se règle dans
    // /champs/shipments et se relit via ce plan (clé logique → colonne ERP).
    // Conséquence pour le write-back : les champs scalaires passent par le
    // chemin DYNAMIQUE de buildColumnMap (sens réglable par champ, clé
    // `dyn:<colonne>`), le mapping cœur ne servant plus qu'aux linked records
    // de la création. `neverPush` garde les colonnes non écrivables côté
    // Airtable même si l'utilisateur y règle un sens push/both.
    uiFieldMapPlan: ENVOIS_FIELD_MAP_PLAN,
    neverPush: new Set(['pays']),
    // Seuls les champs scalaires écrivables côté Airtable sont poussés
    // (tracking_number → "Numéro de tracking", carrier → "Service de livraison",
    //  status → "Statut" singleSelect, shipped_at → "Date" dateTime, notes → "Notes").
    // Exclusions :
    //  • pays    → "Pays de l'adresse de livraison" : champ lookup (multipleLookupValues)
    //              calculé depuis l'adresse liée → non écrivable, un PATCH dessus renverrait 422.
    //              Il se recalcule tout seul côté Airtable quand l'adresse liée change.
    skipKeys: new Set(['items', 'pays']),
    // Les trois linked records des envois réécrits sur update : la colonne ERP
    // porte un id Boréal, `linkColumns` dit vers quelle table le résoudre pour
    // envoyer [recXXX] à Airtable. Le sens reste réglable dans /champs/shipments
    // (clés `dyn:order_id` / `dyn:address_id` / `dyn:items_expedies`) — déclarer
    // la colonne rend le write-back POSSIBLE, il ne l'active pas.
    //
    // Les trois se délient : un lien retiré dans l'ERP pousse [] et délie donc
    // le record côté Airtable (migration 022 pour la commande). C'est voulu —
    // sans ça, retirer une adresse ne se répercuterait jamais et le lookup
    // « Pays » resterait figé sur l'ancienne.
    //
    // `items_expedies` est la colonne miroir de « items expédiés ». Sa valeur ne
    // se saisit pas : elle se RECALCULE depuis order_items.shipment_id (la vérité
    // locale de ce qui part dans le colis) — cf. services/shipmentAirtableLink.js,
    // appelé par l'achat d'étiquette, la création d'un envoi depuis une commande
    // et l'assignation d'un article. Sans elle, un envoi né dans Boréal arrivait
    // dans Airtable sans aucun article lié.
    linkColumns: { order_id: 'orders', address_id: 'adresses', items_expedies: 'order_items' },
    // Linked records à inclure UNIQUEMENT à la création (create ERP→Airtable).
    // Clé = clé du field_map (donne le nom de champ Airtable), resolve → record ids
    // Airtable à lier. `order` et `address` sont aussi poussés sur update via
    // `linkColumns` ; `pays` reste exclu : lookup dérivé de l'adresse, il se
    // remplit tout seul côté Airtable. Les articles ne passent PLUS par ici : la
    // clé `items` n'existe pas dans ENVOIS_FIELD_MAP_PLAN, donc ce résolveur ne
    // s'exécutait jamais depuis le retrait du field_map cœur — ils voyagent
    // désormais dans la colonne miroir `items_expedies` (ci-dessus).
    linkedRecords: {
      order:   (row) => { const id = linkedAirtableId('orders', row.order_id); return id ? [id] : null },
      address: (row) => { const id = linkedAirtableId('adresses', row.address_id); return id ? [id] : null },
    },
  },
  // Webhook write surface (tickets / projects / serial_numbers). Ces modules sont
  // pull-only depuis Airtable ; sans write-back, une écriture ERP sur une colonne
  // mappée serait écrasée au prochain sync. Le write-back est best-effort : il ne
  // pousse que les colonnes scalaires mappées (les colonnes ERP-natives — assigned_to,
  // vendeur_ref, notes, custom fields… — restent en DB, jamais clobberées car le sync
  // entrant fait un upsert sélectif). Les linked records (company/contact) sont exclus.
  // Billets : plus aucune clé cœur (migration 040). Tous les scalaires passent
  // par le chemin dynamique de buildColumnMap, réglable colonne par colonne
  // depuis /champs/tickets — d'où un `skipKeys` VIDE.
  billets: {
    erpTable: 'tickets',
    skipKeys: new Set([]),
    // Un billet NÉ dans Boréal doit arriver dans Airtable RATTACHÉ à son
    // entreprise et à son contact : sans ces deux liens, le billet Airtable
    // n'apparaît sur aucune fiche client et n'y sert à rien. Les deux colonnes
    // portent des record ids Airtable BRUTS (mapping sans table cible, cf.
    // l'identité 'airtable' de routes/custom-fields.js) : le tableau poussé est
    // donc déjà celui qu'Airtable attend, et la table ERP nommée ici ne sert
    // qu'aux valeurs écrites en id Boréal (entreprise née dans l'ERP, sans
    // jumeau Airtable) — même règle que le module `retours`.
    linkColumns: { cf_entreprise: 'companies', cf_contact: 'contacts' },
    // « Documents » est un champ PIÈCES JOINTES côté Airtable, alors que la
    // colonne ERP ne stocke que des descripteurs locaux ({id,name,size,type}),
    // sans URL publique. L'inclure ferait échouer le POST/PATCH ENTIER en 422 —
    // donc perdre aussi les champs légitimes du même billet. Jamais poussé,
    // quel que soit le sens réglé dans /champs/tickets.
    neverPush: new Set(['documents']),
    valueCodecs: {
      // « Notifications » est une case à cocher Airtable : elle refuse un
      // nombre même avec typecast, et la colonne ERP est du texte ('1.0' venu
      // de l'import, 0/1 venu du formulaire).
      notifications: v => Number(v) !== 0,
      // « Mots clés » est un multipleSelects : Airtable attend un TABLEAU de
      // libellés. La colonne stocke un tableau JSON (ou du texte à virgules
      // pour les valeurs saisies avant la reprise) — même découpage que les
      // colonnes lien, d'où `linkKeys`.
      mots_cles: v => (Array.isArray(v) ? v : linkKeys(v)),
    },
  },
  // Projets : plus de field_map en base non plus (cf. retireProjetsCoreFieldMap).
  // « ID » et « Client final » se règlent dans /champs/projects, donc TOUS les
  // scalaires passent par le chemin dynamique de buildColumnMap, sens réglable
  // colonne par colonne (`dyn:<colonne>`). `skipKeys` reste tel quel mais n'a
  // plus d'effet sur le payload : avec un `uiFieldMapPlan`, la boucle cœur est
  // sautée.
  projets: {
    erpTable: 'projects',
    uiFieldMapPlan: PROJETS_FIELD_MAP_PLAN,
    skipKeys: new Set(['company', 'contact']),
    keyToColumn: { company: 'company_id', contact: 'contact_id' },
    // La config Airtable des projets vit dans airtable_projets_config
    // (singleton), pas dans airtable_module_config — d'où la source dédiée. La
    // colonne field_map reste nommée ici : elle sert au repli de lecture, et
    // vaut NULL depuis la reprise.
    configSource: { table: 'airtable_projets_config', baseCol: 'base_id', tableIdCol: 'projects_table_id', fieldMapCol: 'field_map_projects' },
    // Projet né dans Boréal : son client (et son contact) partent avec la
    // création, quel que soit le sens réglé — sans eux, le projet naîtrait
    // orphelin dans Airtable. « Client final » reste en import pour les
    // modifications. Le contact n'a pas de mapping propre : il passe par celui
    // de `contact_lie` (« Contact lié »).
    createLinks: {
      company_id: { table: 'companies' },
      contact_id: { table: 'contacts', mappingColumn: 'contact_lie' },
    },
    valueCodecs: {
      // « Probabilité » est un champ pourcentage : Airtable attend une FRACTION
      // (0.5 = 50 %), la colonne stocke des points (cf. percentToPoints à
      // l'import). Sans conversion, 50 devenait 5 000 %.
      probability: v => (v === '' ? null : Math.round(Number(v) * 100) / 10000),
    },
  },
  // Numéros de série : plus de field_map en base (cf. retireSerialsCoreFieldMap).
  // Tous les scalaires passent donc par le chemin dynamique de buildColumnMap,
  // sens réglable colonne par colonne (`dyn:<colonne>`) ; la reprise a semé
  // 'both' sur les colonnes que l'ERP modifiait déjà. `skipKeys` garde les 3
  // clés lien — comme sur les articles de retour, elles servent encore à
  // retrouver la colonne d'une clé hors de buildColumnMap.
  serials: {
    erpTable: 'serial_numbers',
    uiFieldMapPlan: SERIALS_FIELD_MAP_PLAN,
    skipKeys: new Set(['product', 'company', 'order_item']),
    keyToColumn: { product: 'product_id', company: 'company_id', order_item: 'order_item_id' },
    // Les liens que le module sait renvoyer : « Entreprise de la dernière
    // commande (lien) », « Items commande » et « Produit ». La colonne porte un
    // id Boréal, la table nommée ici dit où le résoudre en record id — sans quoi
    // /champs/serial_numbers verrouillait leur sens sur « Airtable → Boréal »
    // sans recours (raison `link_field`). Déclarer la colonne rend le sens
    // CHOISISSABLE, il n'active aucun push : le défaut d'un mapping dynamique
    // reste 'pull'.
    //
    // `order_item_id` est le rattachement d'un numéro de série à une ligne de
    // commande. C'est BORÉAL qui le pose en pratique (scan de prélèvement, cf.
    // routes/orders.js), donc le renvoyer vers Airtable a un sens — le champ
    // Airtable est un « linked record » écrivable, et le lien retiré dans l'ERP
    // pousse [] (donc délie côté Airtable).
    //
    // `product_id` est le PRODUIT du numéro de série, et il se choisit dans la
    // fiche (PATCH /api/serials/:id). Sans lui ici, la colonne était verrouillée
    // en « Airtable → Boréal » (raison `link_field`) : l'association posée dans
    // Boréal repartait au prochain sync, écrasée par « Produit » d'Airtable. Le
    // champ Airtable est un linked record écrivable ; retirer le produit dans
    // l'ERP pousse [] et délie donc côté Airtable.
    linkColumns: { product_id: 'products', company_id: 'companies', order_item_id: 'order_items' },
  },
  // Paies : plus de field_map en base (cf. retirePaiesCoreFieldMap). Tous les
  // scalaires passent donc par le chemin dynamique de buildColumnMap, sens
  // réglable colonne par colonne (`dyn:<colonne>`) ; la reprise a semé 'both'
  // sur les colonnes que l'ERP modifiait déjà. `skipKeys` reste VIDE : avec un
  // `uiFieldMapPlan`, la boucle cœur est sautée et une clé n'y servirait qu'à
  // verrouiller un sens dans une modale qui n'existe plus pour ce module.
  paies: {
    erpTable: 'paies',
    uiFieldMapPlan: PAIES_FIELD_MAP_PLAN,
    skipKeys: new Set([]),
  },
  paie_items: {
    erpTable: 'paie_items',
    // Clés réelles du field_map (cf. syncPaieItems) : paie_link / employee_link.
    skipKeys: new Set(['paie_link', 'employee_link']),
    keyToColumn: { paie_link: 'paie_id', employee_link: 'employee_id' },
    linkedRecords: {
      paie_link:     (row) => { const id = linkedAirtableId('paies', row.paie_id); return id ? [id] : null },
      employee_link: (row) => { const id = linkedAirtableId('employees', row.employee_id); return id ? [id] : null },
    },
  },
  // Prospects Instagram : l'ERP est la source de vérité, Airtable n'est qu'une
  // surface d'édition pour Philippe. `skipKeys` est VOLONTAIREMENT vide —
  // contrairement à l'intuition, y mettre une clé la force en 'pull' (Airtable →
  // ERP), soit l'inverse du besoin. La protection des champs système passe par
  // le seed de airtable_field_directions (schema.js) : 'push' partout sauf
  // follow_up_status et notes en 'both'. Sans ce seed, fieldMapDirection
  // renverrait 'both' par défaut et une édition Airtable pourrait écraser
  // dm_sent — donc faire recontacter quelqu'un.
  instagram: {
    erpTable: 'instagram_prospects',
    skipKeys: new Set(),
    // SQLite stocke ces colonnes en 0/1 ; les champs Airtable correspondants sont
    // des Cases à cocher, qui refusent un entier même avec typecast (Airtable ne
    // convertit pas nombre → booléen). Coercition explicite ci-dessous.
    booleanKeys: new Set(['dm_sent', 'replied', 'contacted']),
    // « Name » est le champ-titre obligatoire d'Airtable (impossible à
    // supprimer) ; il n'est mappé par aucune clé ERP et resterait donc
    // toujours vide (fiches sans titre). On y reflète le nom d'usager.
    primaryFieldMirror: { from: "Nom d'usager", to: 'Name' },
  },
  // Commandes : plus de field_map en base non plus (cf. retireOrdersCoreFieldMap).
  // Le mapping se règle dans /champs/orders, donc TOUS les scalaires passent par
  // le chemin dynamique de buildColumnMap, sens réglable champ par champ
  // (`dyn:<colonne>`). `skipKeys` est volontairement VIDE : avec un
  // `uiFieldMapPlan`, la boucle cœur de buildColumnMap est sautée, et y laisser
  // une clé ne servirait qu'à verrouiller son sens en 'pull' dans une modale de
  // mapping cœur qui n'existe plus pour ce module.
  //
  // Ce qui est réellement poussé vers Airtable : Notes (multilineText), Priorité
  // (singleSelect), Abonnement (singleSelect Oui/Non, via `valueCodecs`) et
  // « Adresse de livraison » (linked record, cf. `linkColumns`).
  // `neverPush` couvre les deux champs FORMULE d'Airtable — « Statut » et
  // « # de commande » — qu'un PATCH ferait échouer en 422 : la garde tient même
  // si l'utilisateur y règle un sens push/both dans l'interface. Les liens
  // entreprise/projet ne sont posés qu'à la création via `linkedRecords`.
  orders: {
    erpTable: 'orders',
    uiFieldMapPlan: ORDERS_FIELD_MAP_PLAN,
    skipKeys: new Set(),
    neverPush: new Set(['status', 'order_number']),
    keyToColumn: { company: 'company_id', project: 'project_id', address: 'address_id' },
    // L'adresse de livraison se choisit dans la fiche : le lien doit repartir
    // vers Airtable, sinon le prochain import ramènerait l'ancienne. La colonne
    // miroir porte des record ids bruts (mapping sans table cible) — le tableau
    // poussé est donc déjà celui d'Airtable ; `adresses` ne sert qu'aux valeurs
    // écrites en id Boréal (adresse créée ici, sans jumeau Airtable).
    // Même raison pour « Projet » : lié dans la fiche, il était effacé au sync
    // suivant tant qu'Airtable gardait l'ancien lien (ou aucun).
    linkColumns: { adresse_de_livraison: 'adresses', adresse_de_la_ferme_pour_coordonnees_geographiques: 'adresses', project_id: 'projects' },
    // La colonne ERP est un 0/1 ; le champ Airtable « Abonnement » est un
    // singleSelect Oui/Non (pas une case à cocher) — sans ce codec, Airtable
    // reçoit un entier et rejette l'écriture.
    valueCodecs: { is_subscription: v => (v ? 'Oui' : 'Non') },
    // Associations initiales uniquement ; les sens de mise à jour restent inchangés.
    linkedRecords: {
      company: row => airtableLinkIds('companies', row.company_id),
      project: row => airtableLinkIds('projects', row.project_id),
      address: row => airtableLinkIds('adresses', row.address_id),
    },
    configSource: { table: 'airtable_orders_config', baseCol: 'base_id', tableIdCol: 'orders_table_id', fieldMapCol: 'field_map_orders' },
    // Le numéro de Boréal fait foi : il est écrit dans « # de commande » à la
    // création (jamais ensuite — `neverPush`).
    createFields: (row, fieldMap) => (fieldMap.order_number && row.order_number
      ? { [fieldMap.order_number]: `CMD-${row.order_number}` } : {}),
  },
  // Retours (RMA) et leurs articles. Deux tables nées dans Airtable, où une
  // partie du traitement se fait encore : sans write-back, toute saisie faite
  // dans Boréal y était écrasée au sync suivant — d'où le verrou « Airtable →
  // Boréal » que /champs/retours affichait sur CHAQUE champ, sans recours.
  //
  // `defaultDirection: 'pull'` (comme order_items) : déclarer le module rend le
  // sens CHOISISSABLE champ par champ, il n'allume aucun push en douce. Tant
  // que rien n'est passé en « Bidirectionnel », le comportement est identique à
  // avant.
  //
  // Le field_map cœur des retours est VIDE (migrations 037 puis 041) : tous
  // leurs champs sont des mappings dynamiques réglés dans /champs/retours, donc
  // tout passe par le chemin dynamique de buildColumnMap (clé `dyn:<colonne>`).
  retours: {
    erpTable: 'returns',
    skipKeys: new Set(),
    defaultDirection: 'pull',
    // Colonnes lien que le module sait renvoyer : elles portent des record ids
    // Airtable bruts (mapping sans table cible), donc le tableau poussé est
    // déjà celui qu'Airtable attend ; la table ERP nommée ici ne sert qu'aux
    // valeurs écrites en id Boréal (record né dans l'ERP, sans jumeau).
    linkColumns: { cf_entreprise: 'companies', items_retour: 'return_items' },
  },
  // Articles de retour. Plus de field_map cœur en base (cf.
  // retireRetourItemsCoreFieldMap) : les clés restantes se règlent dans
  // /champs/return_items, donc TOUS les scalaires passent par le chemin
  // dynamique de buildColumnMap, sens réglable colonne par colonne
  // (`dyn:<colonne>`). `skipKeys` est VIDE : avec un `uiFieldMapPlan`, la boucle
  // cœur est sautée, et y laisser une clé ne servirait qu'à verrouiller un sens
  // dans une modale de mapping cœur qui n'existe plus pour ce module.
  //
  // Les 4 LIENS du plan (retour, numéro de série, entreprise, produit à
  // recevoir) ont un sens réglable comme tout champ lien : leur mapping porte un
  // `link_target_table`, et writeBackRecord traduit l'id Boréal en [recXXX]
  // (cf. pushableLinkColumn). `keyToColumn` reste : il sert encore à retrouver
  // la colonne d'une clé hors de buildColumnMap.
  //
  // `skipKeys` garde « Retour » seul — contrairement aux autres modules à
  // `uiFieldMapPlan`, où il est vide. `return_id` est la garde d'insertion du
  // miroir (NOT NULL) : un 'push' arrêterait l'import de tout nouvel article.
  // La clé est donc toujours importée (cf. importSkippedCoreKeys) et son sens
  // ne peut être que « Airtable → Boréal » ou « Bidirectionnel ».
  retour_items: {
    erpTable: 'return_items',
    uiFieldMapPlan: RETOUR_ITEMS_FIELD_MAP_PLAN,
    skipKeys: new Set(['return']),
    keyToColumn: {
      return: 'return_id', serial: 'serial_id', company: 'company_id',
      product_to_receive: 'product_id',
    },
    defaultDirection: 'pull',
    // Liens réglés dans /champs/return_items (colonnes à record ids bruts) —
    // mêmes règles que ci-dessus.
    linkColumns: {
      commande: 'orders', commande_associee: 'order_items',
      billets: 'tickets', adresse_de_livraison: 'adresses',
    },
    // Linked records posés à la CRÉATION seulement (retour créé dans Boréal,
    // ex. « Retourner tous les numéros de série »). Le lien vers le retour est
    // vital : le sync entrant IGNORE un article sans retour lié, il naîtrait
    // orphelin dans Airtable.
    linkedRecords: {
      return:  (row) => { const id = linkedAirtableId('returns', row.return_id); return id ? [id] : null },
      serial:  (row) => { const id = linkedAirtableId('serial_numbers', row.serial_id); return id ? [id] : null },
      company: (row) => { const id = linkedAirtableId('companies', row.company_id); return id ? [id] : null },
      product_to_receive: (row) => { const id = linkedAirtableId('products', row.product_id); return id ? [id] : null },
    },
  },
  // Lignes de commande. Le champ intéressant côté ERP est le PRODUIT, qui est un
  // linked record Airtable (« Produit » → table des pièces) : d'où `linkColumns`,
  // qui convertit l'id ERP en record id Airtable au moment du PATCH.
  //
  // `defaultDirection: 'pull'` — contrairement aux modules dont le write-back
  // existait avant le sélecteur de sens, déclarer ce module ne doit RIEN pousser
  // tant que l'utilisateur n'a pas choisi : il rend le sens choisissable, point.
  order_items: {
    erpTable: 'order_items',
    // 'order'     : lien vers la commande, posé à la création via linkedRecords,
    //               puis conservé lors des mises à jour.
    // 'unit_cost' : « Coût unitaire actuel » est un lookup Airtable (dérivé du
    //               produit lié) — non écrivable, un PATCH dessus renvoie 422.
    skipKeys: new Set(['order', 'unit_cost']),
    keyToColumn: { product: 'product_id' },
    // Colonne ERP portant un id local → champ Airtable linked record. Valeur
    // poussée : [record id du produit], ou [] si l'ERP a retiré le produit.
    linkColumns: { product_id: 'products' },
    linkedRecords: {
      order: row => airtableLinkIds('orders', row.order_id),
    },
    requiredCreationLinks: { order: 'order_id', product: 'product_id' },
    defaultDirection: 'pull',
    configSource: { table: 'airtable_orders_config', baseCol: 'base_id', tableIdCol: 'items_table_id', fieldMapCol: 'field_map_items' },
  },
  // Pièces (table ERP `products`). L'inventaire se calcule encore dans Airtable
  // (« Quantité en inventaire » est une formule) : la section « Ajustement
  // d'inventaire » de la fiche pousse « Ajustement manuel » et sa raison, puis
  // Airtable recalcule et le webhook ramène la quantité. `defaultDirection:
  // 'pull'` : seuls les champs passés en bidirectionnel (seed dans schema.js)
  // sont poussés.
  pieces: {
    erpTable: 'products',
    uiFieldMapPlan: PIECES_FIELD_MAP_PLAN,
    skipKeys: new Set(),
    keyToColumn: {},
    defaultDirection: 'pull',
  },
  // Entreprises (CRM). Plus de field_map cœur (cf. retireCompaniesCoreFieldMap) :
  // tout se règle dans /champs/companies, donc tous les scalaires passent par le
  // chemin dynamique de buildColumnMap (`dyn:<colonne>`). `defaultDirection:
  // 'pull'` : déclarer le module rend le sens CHOISISSABLE, il ne pousse rien
  // tant que personne n'a passé un champ en « Bidirectionnel ».
  //
  // Mises à jour seulement : une entreprise née dans Boréal n'est pas créée
  // dans Airtable — « Entreprise », le champ-titre, y est une formule, donc
  // impossible à remplir depuis ici (la fiche y naîtrait sans nom).
  companies: {
    erpTable: 'companies',
    uiFieldMapPlan: COMPANIES_FIELD_MAP_PLAN,
    skipKeys: new Set(),
    defaultDirection: 'pull',
    configSource: { table: 'airtable_sync_config', baseCol: 'base_id', tableIdCol: 'companies_table_id', fieldMapCol: 'field_map_companies' },
  },
  // Mouvements d'inventaire. Field_map cœur à 6 clés (cf. CORE_PLANS du moteur),
  // dont 2 visent des champs calculés d'Airtable (« Created », « Valeur du
  // mouvement ») : buildColumnMap les écarte d'office. `defaultDirection:
  // 'pull'` : déclarer le module rend le sens choisissable dans
  // /champs/stock_movements, il ne pousse rien tant que personne n'a choisi.
  //
  // Le modèle ERP n'est pas celui d'Airtable : Airtable stocke une variation
  // SIGNÉE (« Changement ») et un libellé (« Type », singleSelect) ; l'import en
  // tire `qty` = |variation|, `type` in/out/adjustment et `reason` = le libellé.
  // `pushValues` fait le chemin inverse — `type` Airtable ← `reason`, pas la
  // colonne `type` (« in » n'est pas un libellé Airtable).
  stock_movements: {
    erpTable: 'stock_movements',
    skipKeys: new Set(),
    keyToColumn: { product: 'product_id', qty_change: 'qty', type: 'reason', occurred_at: 'created_at' },
    linkColumns: { product_id: 'products' },
    defaultDirection: 'pull',
    pushValues: {
      qty: row => stockMovementAirtableChange(row),
      reason: row => stockMovementLabel(row),
    },
    // Un mouvement né dans Boréal part vers Airtable avec sa pièce, mais
    // seulement si au moins un champ est en Boréal → Airtable : sinon le lien
    // seul suffirait à créer des mouvements vides côté Airtable.
    createRequiresPush: true,
    linkedRecords: {
      product: row => airtableLinkIds('products', row.product_id),
    },
    requiredCreationLinks: { product: 'product_id' },
  },
}

// Variation signée d'un mouvement (champ « Changement » d'Airtable). Un
// ajustement saisi dans Boréal stocke le niveau CIBLE dans `qty` : l'appelant
// passe alors la vraie variation en `signed_change` (cf. createInAirtable,
// `rowOverrides`). Sinon le signe vient du type, ou du libellé pour un
// ajustement importé (« Ajustement (diminution) »).
export function stockMovementSignedChange(row) {
  if (row.signed_change != null) return Number(row.signed_change)
  const qty = Math.abs(Number(row.qty) || 0)
  if (row.type === 'out') return -qty
  if (row.type === 'adjustment' && /diminution/i.test(row.reason || '')) return -qty
  return qty
}

// Valeur poussée dans « Changement ». Airtable range les ajustements par leur
// libellé (rollups « Ajustements positifs » / « Ajustements négatifs », le
// second SOUSTRAIT) : un ajustement part donc en valeur absolue, le sens est
// porté par le « Type ». Une diminution poussée à -3 ajoutait 3 au stock.
export function stockMovementAirtableChange(row) {
  const change = stockMovementSignedChange(row)
  return row.type === 'adjustment' ? Math.abs(change) : change
}

// Libellé « Type » d'Airtable. Un ajustement garde un libellé « Ajustement… » :
// c'est lui qui, au retour, redonne le type ajustement à l'import.
export function stockMovementLabel(row) {
  if (row.type === 'adjustment' && !/ajustement/i.test(row.reason || '')) {
    return stockMovementSignedChange(row) < 0 ? 'Ajustement (diminution)' : 'Ajustement (augmentation)'
  }
  return row.reason || null
}

// Valeur d'une colonne à pousser : dérivée de la ligne quand le module le
// déclare (`pushValues`), sinon la colonne brute.
function pushedValue(cfg, col, row) {
  const derive = cfg?.pushValues?.[col]
  return airtableFieldValue(cfg, col, derive ? derive(row) : row[col])
}

// Table ERP → module write-back (réciproque de WRITEBACK_MODULES.erpTable).
// Sert aux chemins qui ne connaissent que la table ERP (sync dynamique,
// mapping-data) pour retrouver la clé sous laquelle les sens sont stockés.
const ERP_TABLE_TO_MODULE = Object.fromEntries(
  Object.entries(WRITEBACK_MODULES).map(([m, cfg]) => [cfg.erpTable, m])
)
export function writebackModuleForTable(erpTable) {
  return ERP_TABLE_TO_MODULE[erpTable] || null
}

// ── Champs dynamiques (airtable_field_mappings) ──────────────────────────────
//
// En plus des clés du field_map « cœur », l'utilisateur peut régler le sens de
// sync des champs mappés dynamiquement (page /champs/:table). Leur sens est
// stocké dans airtable_field_directions sous la clé `dyn:<colonne ERP>` — le
// préfixe évite toute collision avec une clé cœur homonyme. Défaut : 'pull'
// (comportement historique — un champ dynamique n'est jamais poussé tant que
// l'utilisateur n'a pas choisi l'inverse).
const DYN_PREFIX = 'dyn:'
export function dynamicDirectionKey(column) { return `${DYN_PREFIX}${column}` }
export function isDynamicDirectionKey(key) { return typeof key === 'string' && key.startsWith(DYN_PREFIX) }

// ── Champs CALCULÉS de Boréal : mappables en sens push seulement ─────────────
//
// Une formule (et de même un lookup, un rollup, un « créé le / modifié par »)
// n'a pas de colonne physique : sa valeur est calculée à la lecture par la VUE
// <table>_v (services/customFieldsView.js). Rien ne peut donc l'ALIMENTER
// depuis Airtable — mais elle peut parfaitement être POUSSÉE vers un champ
// Airtable écrivable. C'est le seul sens possible, et il n'est pas négociable :
// pas de sélecteur de sens sur ces champs.
//
// `button` en est exclu : une action ne porte aucune valeur, il n'y a rien à
// pousser (cf. noMappingReason côté client).
export const PUSH_ONLY_CF_KINDS = new Set([
  'formula', 'lookup', 'rollup',
  'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
])

// Colonnes d'une table portées par un champ calculé actif. Une colonne
// PHYSIQUE en est exclue même si un champ calculé la porte : elle est peut-être
// alimentée par l'import, et le sens de sync doit y rester le choix de
// l'utilisateur. Seules les colonnes virtuelles (celles que seule la vue
// <table>_v produit) sont poussées d'office.
export function pushOnlyColumns(erpTable) {
  try {
    const placeholders = [...PUSH_ONLY_CF_KINDS].map(() => '?').join(',')
    const computed = db.prepare(
      `SELECT column_name FROM custom_fields
       WHERE erp_table=? AND deleted_at IS NULL AND kind IN (${placeholders})`
    ).all(erpTable, ...PUSH_ONLY_CF_KINDS).map(r => r.column_name)
    if (!computed.length) return new Set()
    const physical = new Set(db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name))
    return new Set(computed.filter(c => !physical.has(c)))
  } catch { return new Set() }  // table custom_fields absente (tests)
}

export function dynamicFieldDirection(module, column) {
  if (!module || !WRITEBACK_MODULES[module]) return 'pull'
  // Colonne native à résolveur (ex. projects.vendeur_ref) : la colonne porte une
  // référence Boréal (`employee:<id>`), illisible pour Airtable — jamais poussée.
  if (nativeMappedColumn(WRITEBACK_MODULES[module].erpTable, column)?.pull_only) return 'pull'
  // Champ calculé : le sens ne peut être que 'push', quoi qu'il y ait en base.
  if (pushOnlyColumns(WRITEBACK_MODULES[module].erpTable).has(column)) return 'push'
  // Champ Airtable calculé (formule, rollup, lookup…) : Airtable refuse d'y
  // écrire, seul l'import a un sens — même si 'push'/'both' est enregistré.
  if (isAirtableComputedKey(module, dynamicDirectionKey(column))) return 'pull'
  const override = readDirectionOverride(module, dynamicDirectionKey(column))
  return (override === 'pull' || override === 'push' || override === 'both') ? override : 'pull'
}

// Vrai si le module supporte le write-back → le sens des champs dynamiques y
// est configurable (sauf champs lien non déclarés poussables, cf. ci-dessous).
export function isDynamicDirectionConfigurable(module) {
  return !!WRITEBACK_MODULES[module]
}

// Table ERP cible d'une colonne lien que le module sait POUSSER vers Airtable
// (null si la colonne n'est pas un lien poussable). La table sert à résoudre
// un id Boréal en record id Airtable ; un record id déjà présent passe tel quel.
//
// Sources, dans l'ordre : `linkColumns` déclaré par le module, puis le mapping
// lui-même — sa table cible (`link_target_table`), sinon la table miroir de la
// table Airtable liée (`linked_table_id`). Tout champ lien vers une table
// miroitée est donc bidirectionnel au choix de l'utilisateur ; seul un lien vers
// une table Airtable non miroitée (rien où résoudre) reste en import.
export function pushableLinkColumn(module, column, mappingOptions = null) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return null
  if (cfg.linkColumns?.[column]) return cfg.linkColumns[column]
  let opts = mappingOptions
  if (!opts) {
    try {
      const row = db.prepare(
        `SELECT options FROM airtable_field_mappings
          WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
      ).get(cfg.erpTable, column)
      opts = JSON.parse(row?.options || '{}')
    } catch { return null }
  }
  let table = opts.link_target_table || null
  if (!table && opts.linked_table_id) {
    try { table = erpTableForAirtableTableId(opts.linked_table_id) } catch { table = null }
  }
  return table && hasAirtableIdColumn(table) ? table : null
}

// Vrai si la table ERP porte une colonne `airtable_id` (seul moyen de traduire
// un id Boréal en record id).
function hasAirtableIdColumn(table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return false
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'airtable_id')
  } catch { return false }
}

// Colonnes lien DÉCLARÉES par le module (`linkColumns`) — le sync entrant ne
// les écrit qu'en COALESCE, d'où leur traitement à part dans l'audit du miroir.
export function declaredLinkColumn(module, column) {
  return WRITEBACK_MODULES[module]?.linkColumns?.[column] || null
}

// Clés cœur que l'import doit sauter : sens 'push' (Boréal → Airtable seul).
// Pour un module à `uiFieldMapPlan`, le sens se règle dans /champs/:table sur
// la COLONNE de la clé (`dyn:<colonne>`) : c'est lui qui compte. Une clé de
// `skipKeys` n'est jamais sautée (rattachement requis à l'import).
export function importSkippedCoreKeys(module, keys) {
  const cfg = WRITEBACK_MODULES[module]
  const out = new Set()
  if (!cfg) return out
  for (const key of keys) {
    if (fieldMapDirection(module, key) === 'push') { out.add(key); continue }
    const column = cfg.uiFieldMapPlan?.[key]
    if (column && !cfg.skipKeys.has(key) && dynamicFieldDirection(module, column) === 'push') out.add(key)
  }
  return out
}

// Colonne ERP d'une clé cœur verrouillée en import (`skipKeys`) pour un module
// à `uiFieldMapPlan` — son sens peut être bidirectionnel, jamais 'push'.
export function isImportRequiredColumn(module, column) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg?.uiFieldMapPlan) return false
  return Object.entries(cfg.uiFieldMapPlan).some(([key, col]) => col === column && cfg.skipKeys.has(key))
}

// ── Champs CALCULÉS côté AIRTABLE : jamais réécrits ──────────────────────────
//
// Une FORMULE Airtable — et de même un rollup, un lookup, un count, un
// autoNumber, un « créé le / modifié par », un bouton — est calculée par
// Airtable : l'API refuse toute écriture dessus (422). Le sens de sync d'un tel
// champ ne peut donc être que « Airtable → Boréal », quel que soit le réglage
// enregistré, et le write-back doit l'écarter de son payload.
//
// C'est la version GÉNÉRALE de `neverPush`, qui exigeait de nommer chaque champ
// à la main, module par module (« Statut » et « # de commande » des commandes,
// « Pays » des envois…) : le type vient du cache alimenté par toutes les
// lectures de métadonnées Airtable — cf. services/airtableFieldTypes.js.
//
// Le résultat est mémoïsé par module : ces fonctions sont appelées dans des
// boucles par enregistrement (moteur de miroir), où reconstruire le field_map à
// chaque clé coûterait bien plus que la réponse ne vaut.
const computedKeyCache = new Map()   // module → { keys: Set, at: number }
const COMPUTED_KEYS_TTL_MS = 30_000

/** Oublie les clés calculées mémoïsées (mapping modifié, types rafraîchis). */
export function resetComputedKeyCache() { computedKeyCache.clear() }

// Clés de sens ('dyn:<colonne>' et clés du field_map cœur) dont le champ
// Airtable visé est calculé. Vide dès que la table n'a aucun champ calculé
// connu — le cas où le cache de types n'a jamais été alimenté inclus : on ne
// verrouille alors rien, l'ancien comportement s'applique.
function computedKeysForModule(module) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return new Set()
  const hit = computedKeyCache.get(module)
  if (hit && Date.now() - hit.at < COMPUTED_KEYS_TTL_MS) return hit.keys
  const keys = new Set()
  try {
    const config = readAirtableConfig(module)
    const computed = computedAirtableFieldNames(config?.base_id, config?.table_id)
    if (computed.size) {
      // Mappings dynamiques (/champs/:table) → clé `dyn:<colonne>`.
      try {
        const defs = db.prepare(`
          SELECT airtable_field_name, column_name FROM airtable_field_mappings
          WHERE erp_table=? AND import_disabled IS NOT 1 AND column_name != '__pending__'
        `).all(cfg.erpTable)
        for (const d of defs) {
          if (d.column_name && computed.has(d.airtable_field_name)) keys.add(dynamicDirectionKey(d.column_name))
        }
      } catch { /* table de mappings absente (tests) */ }
      // Clés du field_map « cœur » (modale de mapping) → clé nue.
      const fieldMap = readFieldMap(module, config)
      for (const [k, v] of Object.entries(fieldMap || {})) {
        if (typeof v === 'string' && computed.has(v)) keys.add(k)
      }
    }
  } catch { /* config illisible : rien de verrouillé */ }
  computedKeyCache.set(module, { keys, at: Date.now() })
  return keys
}

/**
 * Vrai si la clé de sens vise un champ Airtable calculé — donc non écrivable.
 * `key` est soit une clé du field_map cœur, soit `dyn:<colonne ERP>`.
 */
export function isAirtableComputedKey(module, key) {
  return computedKeysForModule(module).has(key)
}

// Sens de synchronisation d'une clé du field_map d'un module, pour affichage
// (modale de mapping) ET pour piloter le write-back : 'both' = importé depuis
// Airtable ET réécrit vers Airtable, 'pull' = Airtable → ERP seulement, 'push' =
// ERP → Airtable seulement. Les clés non write-back-éligibles (module sans
// write-back, ou linked record / champ calculé exclu) sont toujours 'pull' et
// non configurables. Sinon, l'utilisateur peut choisir le sens (table
// airtable_field_directions) ; défaut = 'both', ou `defaultDirection` du module
// (les modules ajoutés APRÈS le sélecteur de sens partent en 'pull' : déclarer
// le module rend le choix possible, il n'active pas un write-back en douce).
export function fieldMapDirection(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return 'pull'
  if (cfg.skipKeys.has(key)) return 'pull'
  // Champ Airtable calculé : non écrivable, donc import seulement.
  if (isAirtableComputedKey(module, key)) return 'pull'
  const override = readDirectionOverride(module, key)
  return (override === 'pull' || override === 'push' || override === 'both')
    ? override
    : (cfg.defaultDirection || 'both')
}

// Vrai si le sens de sync de cette clé est configurable par l'utilisateur
// (champ scalaire write-back-éligible d'un module supportant le write-back).
export function isDirectionConfigurable(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  return !!(cfg && !cfg.skipKeys.has(key) && !isAirtableComputedKey(module, key))
}

// Raison pour laquelle le sens d'une clé cœur est verrouillé en 'pull' (null si
// configurable) — exposée dans les réponses core-map/mapping-data pour que le
// client affiche une infobulle honnête au lieu du texte générique :
//   'module_no_writeback' → le module ne supporte pas (encore) le write-back
//   'core_skip'           → clé du field_map exclue (linked record / valeur
//                            dérivée) : gérée par la synchronisation cœur.
//   'airtable_computed'   → le champ Airtable visé est une formule (ou rollup,
//                            lookup…) : Airtable refuse toute écriture dessus.
export function coreDirectionLockReason(module, key) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return 'module_no_writeback'
  if (cfg.skipKeys.has(key)) return 'core_skip'
  if (isAirtableComputedKey(module, key)) return 'airtable_computed'
  return null
}

// Lit le sens choisi par l'utilisateur pour une clé (null si aucun override).
function readDirectionOverride(module, key) {
  try {
    const row = db.prepare('SELECT direction FROM airtable_field_directions WHERE module=? AND field_key=?').get(module, key)
    return row?.direction || null
  } catch { return null }
}

// Enregistre le sens de sync choisi pour une clé configurable. Lève si le sens
// est invalide ou si la clé n'est pas configurable (linked record / module sans
// write-back — on ne peut pas y activer un write-back fiable).
export function setFieldDirection(module, key, direction) {
  if (!['pull', 'push', 'both'].includes(direction)) throw new Error('Sens invalide (pull, push ou both)')
  const configurable = isDynamicDirectionKey(key)
    ? isDynamicDirectionConfigurable(module)
    : isDirectionConfigurable(module, key)
  if (!configurable) throw new Error('Ce champ ne supporte pas le choix du sens de synchronisation')
  // Champ calculé : rien ne peut l'alimenter depuis Airtable, seul 'push' a un sens.
  if (isDynamicDirectionKey(key) && direction !== 'push'
      && pushOnlyColumns(WRITEBACK_MODULES[module].erpTable).has(key.slice(DYN_PREFIX.length))) {
    throw new Error('Champ calculé : seul le sens Boréal → Airtable est possible')
  }
  // Champ Airtable calculé (formule, rollup, lookup, autoNumber…) : Airtable
  // rejette tout PATCH dessus. Le sens bidirectionnel, comme le sens
  // Boréal → Airtable, n'aboutirait qu'à des 422 invisibles pour l'utilisateur.
  if (direction !== 'pull' && isAirtableComputedKey(module, key)) {
    throw new Error('Ce champ est une formule dans Airtable : Airtable en refuse toute modification, seul l’import est possible')
  }
  db.prepare(`
    INSERT INTO airtable_field_directions (module, field_key, direction)
    VALUES (?,?,?)
    ON CONFLICT(module, field_key) DO UPDATE SET direction=excluded.direction
  `).run(module, key, direction)
  return direction
}

// Lit base_id / table_id / field_map du module. La plupart des modules vivent dans
// airtable_module_config (clé `module`), mais certains (projets) ont leur propre
// table singleton — déclaré via cfg.configSource. Retourne null si absent.
function readAirtableConfig(module) {
  const src = WRITEBACK_MODULES[module]?.configSource
  if (src) {
    // Colonnes interpolées depuis configSource (littéraux du code, jamais user input) → safe.
    return db.prepare(
      `SELECT ${src.baseCol} AS base_id, ${src.tableIdCol} AS table_id, ${src.fieldMapCol} AS field_map FROM ${src.table} LIMIT 1`
    ).get()
  }
  return db.prepare('SELECT base_id, table_id, field_map FROM airtable_module_config WHERE module=?').get(module)
}

// field_map du module : lu en base pour les modules à mapping « cœur »,
// reconstruit depuis /champs/:table (airtable_field_mappings) pour ceux qui
// déclarent un `uiFieldMapPlan` — cf. services/airtableUiFieldMap.js.
function readFieldMap(module, config) {
  const cfg = WRITEBACK_MODULES[module]
  if (cfg?.uiFieldMapPlan) return fieldMapFromUi(cfg.erpTable, cfg.uiFieldMapPlan)
  try { return JSON.parse(config?.field_map || 'null') } catch { return null }
}

// Config Airtable exploitable pour un write-back : base + table, plus un
// field_map pour les modules qui en dépendent encore.
function writebackConfigMissing(module, config) {
  if (!config?.base_id || !config?.table_id) return true
  return !WRITEBACK_MODULES[module]?.uiFieldMapPlan && !config.field_map
}

// Tables exposées au moteur de webhooks → clé module write-back correspondante.
// Une écriture du webhook sur une de ces tables déclenche un write-back best-effort.
export const TABLE_TO_WRITEBACK_MODULE = {
  tickets: 'billets',
  projects: 'projets',
  serial_numbers: 'serials',
}

// TTL de la garde : au-delà, une entrée non consommée est considérée périmée
// (le webhook a été manqué ou un vrai changement Airtable est survenu depuis).
const GUARD_TTL_MS = 2 * 60 * 1000

// Normalise une valeur (envoyée ou reçue d'Airtable) pour comparaison d'echo.
function normVal(v) {
  if (v == null || v === '') return ''
  if (Array.isArray(v)) return v.map(normVal).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).trim()
}

// Mémorise les champs poussés vers Airtable AVANT le PATCH, pour que le webhook
// de retour (echo) soit reconnaissable même s'il arrive très vite.
export function recordWriteback(airtableId, fields) {
  db.prepare(`
    INSERT INTO airtable_writeback_guard (airtable_id, fields_json, written_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(airtable_id) DO UPDATE SET
      fields_json = excluded.fields_json,
      written_at = excluded.written_at
  `).run(airtableId, JSON.stringify(fields))
}

// Appelé par le sync entrant (webhook) pour chaque record Airtable. Renvoie true
// si ce record correspond à un write-back ERP récent dont les valeurs n'ont pas
// changé depuis → c'est notre propre echo, le sync doit l'ignorer.
// Consomme (supprime) l'entrée de garde dans tous les cas où elle est résolue.
export function consumeWritebackEcho(airtableId, airtableFields) {
  const row = db.prepare('SELECT fields_json, written_at FROM airtable_writeback_guard WHERE airtable_id=?').get(airtableId)
  if (!row) return false

  const age = Date.now() - new Date(row.written_at).getTime()
  if (!(age >= 0) || age > GUARD_TTL_MS) {
    // Entrée périmée : on la nettoie et on laisse le sync traiter normalement.
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  let pushed
  try { pushed = JSON.parse(row.fields_json) } catch { pushed = null }
  if (!pushed || typeof pushed !== 'object') {
    db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    return false
  }

  // Echo confirmé seulement si TOUS les champs poussés correspondent encore aux
  // valeurs Airtable actuelles. Sinon un vrai changement a eu lieu après notre
  // write → on laisse le sync l'appliquer.
  const fields = airtableFields || {}
  const isEcho = Object.entries(pushed).every(([k, v]) => normVal(fields[k]) === normVal(v))

  // Garde à usage unique : on la supprime qu'il s'agisse d'un echo ou non.
  db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
  return isEcho
}

// Valeur à envoyer à Airtable pour une colonne ERP, selon le module.
//   • `valueCodecs[col]`  : traduction explicite (ex. is_subscription 0/1 → « Non »/« Oui »
//                           sur un singleSelect Airtable). Un null reste un null :
//                           on efface le champ, on ne traduit pas « vide ».
//   • `booleanKeys`       : colonne 0/1 → vrai booléen (case à cocher Airtable,
//                           qui refuse un entier même avec typecast).
//   • sinon la valeur brute, `undefined` ramené à null (= effacer le champ).
// Exportée pour être testable sans appel réseau : c'est la seule règle de
// conversion du write-back, partagée par le PATCH de mise à jour et le POST de
// création.
export function airtableFieldValue(cfg, col, value) {
  const codec = cfg?.valueCodecs?.[col]
  if (codec) return value == null ? null : codec(value)
  if (cfg?.booleanKeys?.has(col)) return value == null ? null : !!value
  return value ?? null
}

// Construit la correspondance colonne ERP → nom de champ Airtable à partir du
// field_map du module, en excluant les clés non scalaires, puis y ajoute les
// champs dynamiques (airtable_field_mappings) dont l'utilisateur a réglé le
// sens sur push/both.
export function buildColumnMap(module, fieldMap) {
  const cfg = WRITEBACK_MODULES[module]
  const out = {}
  // Module sans field_map en base (mapping réglé dans /champs/:table) : ses
  // champs scalaires sont des mappings dynamiques, traités plus bas — les
  // reprendre ici les ferait pousser sous une clé de sens (`<clé>`) que l'UI
  // n'expose plus, au lieu de `dyn:<colonne>`.
  if (!cfg.uiFieldMapPlan) {
    for (const [key, atField] of Object.entries(fieldMap || {})) {
      if (!atField) continue                       // pas de champ Airtable mappé
      if (cfg.skipKeys.has(key)) continue          // linked record / non scalaire
      if (fieldMapDirection(module, key) === 'pull') continue  // sens Airtable → ERP : pas de write-back
      const col = cfg.keyToColumn?.[key] || key
      out[col] = atField
    }
  }
  // Champs dynamiques : défaut 'pull' (jamais poussés) — seuls ceux passés en
  // push/both par l'utilisateur rejoignent le write-back. Les champs lien sont
  // exclus (la colonne ERP porte un id local, pas une valeur Airtable).
  try {
    const defs = db.prepare(`
      SELECT airtable_field_name, column_name, options FROM airtable_field_mappings
      WHERE erp_table=? AND import_disabled IS NOT 1 AND column_name != '__pending__'
    `).all(cfg.erpTable)
    // Champs Airtable déjà écrits par une autre colonne (cœur ou dynamique) :
    // depuis qu'un même champ Airtable peut alimenter plusieurs colonnes Boréal,
    // deux d'entre elles pourraient prétendre le remplir. À l'import c'est sans
    // risque (une source, deux copies) ; au write-back ce serait une valeur
    // tirée au sort. La première colonne rencontrée garde la main.
    const pushed = new Set(Object.values(out))
    for (const d of defs) {
      if (!d.column_name || out[d.column_name]) continue  // colonne déjà couverte par le mapping cœur
      if (pushed.has(d.airtable_field_name)) continue     // champ Airtable déjà poussé par une autre colonne
      if (cfg.neverPush?.has(d.column_name)) continue     // champ calculé/lookup Airtable : un PATCH renverrait 422
      if (dynamicFieldDirection(module, d.column_name) === 'pull') continue
      let opts = {}
      try { opts = JSON.parse(d.options || '{}') } catch {}
      // Champ lien : Airtable attend un TABLEAU de record IDs ; la colonne ERP
      // porte des ids Boréal (`link_target_table`) ou des record IDs en texte
      // (`linked_table_id` seul). writeBackRecord les traduit en [recXXX] via
      // la table de pushableLinkColumn ; sans table où résoudre (table Airtable
      // non miroitée), le champ n'est pas poussé.
      if ((opts.link_target_table || opts.linked_table_id) && !pushableLinkColumn(module, d.column_name, opts)) continue
      out[d.column_name] = d.airtable_field_name
      pushed.add(d.airtable_field_name)
    }
  } catch { /* table de mappings absente (tests) : champs cœur seulement */ }
  // Dernier filet, valable pour TOUS les modules : un champ Airtable calculé
  // (formule, rollup, lookup, autoNumber…) n'accepte aucune écriture — l'inclure
  // ferait échouer le PATCH entier en 422, donc perdre aussi les champs
  // légitimes du même payload. `neverPush` ne couvrait que les cas connus
  // d'avance ; ici la garde vient du type réel du champ.
  let computed = new Set()
  try {
    const atConfig = readAirtableConfig(module)
    computed = computedAirtableFieldNames(atConfig?.base_id, atConfig?.table_id)
  } catch { /* config illisible (tests) : aucun champ n'est réputé calculé */ }
  for (const [col, atField] of Object.entries(out)) {
    if (computed.has(atField)) delete out[col]
  }
  return out
}

// Complète `row` (lue sur la table physique) avec la valeur des colonnes
// CALCULÉES mappées, qui n'existent que dans la vue <table>_v. Mute `row` et
// renvoie l'ensemble des colonnes ainsi remplies (vide si le module n'en mappe
// aucune — la vue n'est alors même pas interrogée).
function mergeComputedValues(erpTable, recordId, row, columnMap) {
  const cols = [...pushOnlyColumns(erpTable)].filter(c => columnMap[c] && !(c in row))
  if (!cols.length) return new Set()
  const relation = readRelation(erpTable)
  if (relation === erpTable) return new Set()   // vue absente : rien à calculer
  const values = db.prepare(
    `SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM ${relation} WHERE id=?`
  ).get(recordId)
  if (!values) return new Set()
  Object.assign(row, values)
  return new Set(cols)
}

// Pousse une modification d'un record ERP vers Airtable.
// @param module        clé module Airtable ('achats')
// @param recordId      id ERP du record
// @param changedColumns  optionnel : colonnes réellement modifiées (filtre le payload)
export async function writeBackRecord(module, recordId, changedColumns = null) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try : les lectures DB (config, record), buildColumnMap
  // et getFrozenColumns peuvent lever AVANT l'appel réseau. Sans ce filet, ces
  // throws s'échappaient en fire-and-forget et n'étaient capturés que par un
  // console.error côté route — aucune trace dans sync_log, write-back rompu en
  // silence. Désormais tout échec produit exactement une entrée sync_log error.
  const t0 = Date.now()
  let airtableId = null
  try {
    const config = readAirtableConfig(module)
    if (writebackConfigMissing(module, config)) return { skipped: 'config Airtable absente' }

    const row = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!row) return { skipped: 'record introuvable' }
    if (!row.airtable_id) return { skipped: 'record non lié à Airtable' } // pilote : update only
    airtableId = row.airtable_id

    const fieldMap = readFieldMap(module, config)
    if (!fieldMap) return { skipped: 'field_map illisible' }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)
    const changedSet = changedColumns ? new Set(changedColumns) : null
    // Champs calculés mappés : leur valeur n'est pas dans la table physique, on
    // la lit dans la vue <table>_v. Ils échappent aussi au filtre `changedColumns` :
    // une formule dépend d'AUTRES colonnes, donc « la formule n'a pas changé »
    // n'existe pas — on la repousse à chaque write-back du record.
    const computed = mergeComputedValues(cfg.erpTable, recordId, row, columnMap)

    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (changedSet && !changedSet.has(col) && !computed.has(col)) continue   // ne pousser que ce qui a changé
      if (frozen.has(col)) continue                       // colonne gelée : jamais écrite
      if (!(col in row)) continue                         // colonne supprimée de la table : ne pas pousser null
      // Colonne lien : Airtable attend un tableau de record ids. Un référent sans
      // jumeau Airtable est SAUTÉ plutôt que poussé vide — effacer le lien serait
      // pire que ne rien faire. Vide côté ERP → [] = délier côté Airtable.
      const linkTable = pushableLinkColumn(module, col)
      if (linkTable) {
        const ids = airtableLinkIds(linkTable, row[col])
        if (ids === null) continue
        fields[atField] = ids
        continue
      }
      fields[atField] = pushedValue(cfg, col, row)  // null = effacer le champ Airtable
    }
    if (cfg.primaryFieldMirror && fields[cfg.primaryFieldMirror.from] != null) {
      fields[cfg.primaryFieldMirror.to] = fields[cfg.primaryFieldMirror.from]
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    // Mémoriser AVANT le PATCH : le webhook peut revenir avant la fin du fetch.
    recordWriteback(airtableId, fields)
    await airtablePatch(`/${config.base_id}/${config.table_id}/${airtableId}`, token, {
      fields,
      typecast: true,
    })
    logSync(module, 'erp-writeback', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`↩️  Write-back ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    // Échec : retirer la garde (si posée) sinon elle masquerait un vrai sync entrant ultérieur.
    if (airtableId) db.prepare('DELETE FROM airtable_writeback_guard WHERE airtable_id=?').run(airtableId)
    logSync(module, 'erp-writeback', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Write-back ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}

// Crée dans Airtable un record ERP qui n'y existe pas encore (sens ERP → Airtable),
// puis mémorise l'airtable_id retourné sur la ligne ERP. C'est le pendant « création »
// de writeBackRecord (qui ne gère que l'update d'un record déjà lié). Pousse les
// champs scalaires (mêmes exclusions que l'update) + les linked records configurés
// dans WRITEBACK_MODULES[module].linkedRecords (commande, adresse, items). La garde
// anti-boucle est posée pour que le webhook de création de retour soit reconnu comme
// notre propre echo et non ré-importé. Idempotent : si le record a déjà un airtable_id,
// on ne fait rien.
// ── Champs calculés par Airtable, au moment de la création ERP → Airtable ─────
//
// Airtable renvoie le record créé AVEC ses champs calculés (« # d'envoi », qui
// est une formule/autonumber, lookups…). Sans cette passe, ces valeurs
// n'arriveraient dans l'ERP qu'au prochain sync complet : le webhook « record
// created » qui les rapporterait est justement reconnu comme notre propre echo
// par la garde anti-boucle et ignoré. Un envoi créé dans l'ERP restait donc sans
// numéro d'envoi, parfois pendant des jours.
//
// Règle de prudence : on ne remplit QUE des colonnes vides côté ERP, et
// uniquement à partir de valeurs Airtable non vides. Jamais d'écrasement — le
// chemin sert aussi de rattrapage pour de vieux envois (PATCH d'un record sans
// airtable_id), dont les colonnes ERP-natives ne doivent pas être effacées.
async function importCreatedComputedFields(cfg, recordId, atFields) {
  const { convertValue } = await import('./airtableAutoSync.js')
  const frozen = getFrozenColumns(cfg.erpTable)
  const liveCols = new Set(db.prepare(`PRAGMA table_info(${cfg.erpTable})`).all().map(c => c.name))
  const defs = db.prepare(`
    SELECT m.airtable_field_id, m.airtable_field_name, m.column_name, m.options,
           cf.type AS render_type, cf.options AS render_options
    FROM airtable_field_mappings m
    LEFT JOIN custom_fields cf
      ON cf.erp_table = m.erp_table AND cf.column_name = m.column_name AND cf.deleted_at IS NULL
    WHERE m.erp_table=? AND m.import_disabled IS NOT 1 AND m.column_name != '__pending__'
  `).all(cfg.erpTable)

  let filled = 0
  for (const d of defs) {
    // Defs `native_*` : leur airtable_field_name est un libellé ERP, pas un champ Airtable.
    if (String(d.airtable_field_id || '').startsWith('native_')) continue
    if (!d.column_name || !liveCols.has(d.column_name)) continue
    if (frozen.has(d.column_name)) continue
    const raw = atFields[d.airtable_field_name]
    if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) continue

    let mappingOptions = {}
    try { mappingOptions = JSON.parse(d.options || '{}') } catch { /* options illisibles */ }
    let renderOptions = {}
    try { renderOptions = JSON.parse(d.render_options || '{}') } catch { /* options illisibles */ }
    const isLink = !!mappingOptions.link_target_table
    const value = convertValue(raw, isLink ? 'link' : (d.render_type || 'text'), {
      format: mappingOptions.format,
      ...renderOptions,
      link_target_table: mappingOptions.link_target_table || null,
      ref_resolver: mappingOptions.ref_resolver || null,
    })
    if (value == null || value === '') continue

    // Colonne interpolée : provient de airtable_field_mappings, pas d'une saisie
    // libre de la requête — et validée contre les colonnes live juste au-dessus.
    const res = db.prepare(
      `UPDATE ${cfg.erpTable} SET ${d.column_name}=? WHERE id=? AND (${d.column_name} IS NULL OR ${d.column_name}='')`
    ).run(value, recordId)
    filled += res.changes
  }
  return filled
}

// `rowOverrides` : valeurs connues de l'appelant seulement, lues à la place de
// la ligne (ex. la variation d'un ajustement de stock, que la table ne garde pas).
export async function createInAirtable(module, recordId, { initialFields = {}, rowOverrides = {} } = {}) {
  const cfg = WRITEBACK_MODULES[module]
  if (!cfg) return { skipped: 'module non éligible' }

  // Tout le corps est sous try (cf. writeBackRecord) : les lectures DB et la
  // construction du payload peuvent lever AVANT l'appel réseau. C'est précisément
  // le cas qui cassait le 2-way sync en silence — un envoi créé dans l'ERP restait
  // sans airtable_id quand Airtable était indisponible, et le throw fire-and-forget
  // n'aboutissait qu'à un console.error. Désormais chaque échec laisse une trace
  // sync_log error (avec le recordId) exploitable depuis l'historique des syncs.
  const t0 = Date.now()
  try {
    const config = readAirtableConfig(module)
    if (writebackConfigMissing(module, config)) return { skipped: 'config Airtable absente' }

    const dbRow = db.prepare(`SELECT * FROM ${cfg.erpTable} WHERE id=?`).get(recordId)
    if (!dbRow) return { skipped: 'record introuvable' }
    if (dbRow.airtable_id) return { skipped: 'record déjà lié à Airtable' }
    const row = { ...dbRow, ...rowOverrides }

    const fieldMap = readFieldMap(module, config)
    if (!fieldMap) return { skipped: 'field_map illisible' }

    const columnMap = buildColumnMap(module, fieldMap)
    const frozen = getFrozenColumns(cfg.erpTable)
    mergeComputedValues(cfg.erpTable, recordId, row, columnMap)

    // Champs scalaires : on n'envoie que les valeurs non vides (un null sur un champ
    // singleSelect/lookup inexistant à la création est inutile et peut bruiter).
    // Les colonnes lien poussables (`linkColumns`) portent un id Boréal : elles
    // se traduisent en [recXXX], jamais en texte brut — sans quoi Airtable
    // recevrait un uuid dans un champ « linked record ».
    const fields = {}
    for (const [col, atField] of Object.entries(columnMap)) {
      if (frozen.has(col)) continue
      const linkTable = pushableLinkColumn(module, col)
      if (linkTable) {
        const ids = airtableLinkIds(linkTable, row[col])
        if (ids && ids.length) fields[atField] = ids
        continue
      }
      const v = pushedValue(cfg, col, row)
      if (v != null && v !== '') fields[atField] = v
    }
    if (cfg.primaryFieldMirror && fields[cfg.primaryFieldMirror.from] != null) {
      fields[cfg.primaryFieldMirror.to] = fields[cfg.primaryFieldMirror.from]
    }
    if (cfg.createRequiresPush && !Object.keys(fields).length) {
      return { skipped: 'aucun champ en Boréal → Airtable' }
    }

    // Linked records (commande, adresse, items) — seulement si le field_map nomme le
    // champ Airtable correspondant et qu'on a des record ids à lier.
    for (const [key, resolve] of Object.entries(cfg.linkedRecords || {})) {
      const atField = fieldMap[key]
      if (!atField) continue
      const ids = resolve(row)
      if (ids && ids.length) fields[atField] = ids
    }

    // Liens posés à la création seulement, quel que soit leur sens de sync
    // (cf. `createLinks` du module). Le champ Airtable est celui du mapping
    // dynamique de la colonne.
    for (const [col, { table, mappingColumn }] of Object.entries(cfg.createLinks || {})) {
      const atField = db.prepare(
        `SELECT airtable_field_name FROM airtable_field_mappings
         WHERE erp_table=? AND column_name=? AND import_disabled IS NOT 1`
      ).get(cfg.erpTable, mappingColumn || col)?.airtable_field_name
      if (!atField || fields[atField]) continue
      const ids = airtableLinkIds(table, row[col])
      if (ids && ids.length) fields[atField] = ids
    }

    // Valeurs initiales explicites d'un formulaire de création (validées par
    // l'appelant serveur). Aucun effet sur les sens de sync des mises à jour.
    if (cfg.createFields) Object.assign(fields, cfg.createFields(row, fieldMap))
    Object.assign(fields, initialFields)

    // Ne jamais créer une ligne détachée de sa commande ou de son produit.
    for (const [key, column] of Object.entries(cfg.requiredCreationLinks || {})) {
      const atField = fieldMap[key]
      if (!atField || !Array.isArray(fields[atField]) || !fields[atField].length) {
        throw new Error(`Lien Airtable requis manquant : ${column}`)
      }
    }

    if (Object.keys(fields).length === 0) return { skipped: 'aucun champ à pousser' }

    const token = await getAccessToken()
    const resp = await airtablePost(`/${config.base_id}/${config.table_id}`, token, { fields, typecast: true })
    const airtableId = resp?.id
    if (!airtableId) throw new Error('réponse Airtable sans id')

    // Atomique : poser l'airtable_id ET la garde anti-boucle dans une seule
    // transaction. Si recordWriteback échouait après l'UPDATE, la garde manquerait
    // et le webhook « record created » ré-importerait le record en doublon (boucle
    // de sync). Le tout-ou-rien garantit qu'on n'a jamais un airtable_id lié sans
    // sa garde, ni l'inverse.
    db.transaction(() => {
      db.prepare(`UPDATE ${cfg.erpTable} SET airtable_id=? WHERE id=?`).run(airtableId, recordId)
      // Garde anti-boucle : le webhook « record created » va revenir avec ces valeurs,
      // consumeWritebackEcho le reconnaîtra et le sync entrant ne le ré-importera pas.
      recordWriteback(airtableId, fields)
    })()

    // Récupère les champs calculés par Airtable (« # d'envoi »…) depuis la réponse
    // du POST. Best-effort : un échec ici ne remet pas en cause la création, le
    // prochain sync complet rattrapera les valeurs manquantes.
    try {
      await importCreatedComputedFields(cfg, recordId, resp?.fields || {})
    } catch (e) {
      console.error(`❌ Create ${module} ${recordId} — champs calculés:`, e.message)
    }

    logSync(module, 'erp-create', { status: 'success', modified: 1, durationMs: Date.now() - t0 })
    console.log(`➕ Create ${module} → Airtable ${airtableId} (${Object.keys(fields).join(', ')})`)
    return { ok: true, airtable_id: airtableId, fields }
  } catch (e) {
    logSync(module, 'erp-create', { status: 'error', error: `${recordId}: ${e.message}`, durationMs: Date.now() - t0 })
    console.error(`❌ Create ${module} ${recordId}:`, e.message)
    return { error: e.message }
  }
}
