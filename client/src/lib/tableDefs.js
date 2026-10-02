import { OPS_AREAS, OPS_SEVERITIES, OPS_STATUSES } from './opsIssues.js'

// Métadonnées des colonnes par table — partagées entre les pages et l'admin.
// Les fonctions render() restent dans les composants de page.
// Ce fichier est la source de vérité pour : id, label, field, visibilité, tri, filtre, group.

export const TABLE_LABELS = {
  achats_fournisseurs:   'Achat fournisseur',
  vendor_subscriptions:  'Abonnement fournisseur',
  vendor_profiles:       'Profil fournisseur',
  tasks:          'Tâches',
  companies:      'Entreprises',
  contacts:       'Contacts',
  projects:       'Projets',
  products:       'Produits',
  orders:         'Commandes',
  order_items:    'Articles de commande',
  interactions:   'Interactions',
  tickets:        'Billets',
  purchases:      'Achats',
  serial_numbers: 'Numéros de série',
  retours:        'Retours',
  // Clé de VUE du tableau « Articles » de la fiche retour, et clé de CHAMPS de
  // la table SQL qui porte ces lignes (return_items) — voir sqlTableForView /
  // fieldKeyForView (lib/customFieldDisplay.jsx).
  retour_items:   'Articles de retour',
  return_items:   'Articles de retour',
  factures:       'Factures',
  project_factures: 'Factures (projet)',
  project_soumissions: 'Soumissions (projet)',
  project_commissions: 'Commissions (projet)',
  company_contacts: 'Contacts (entreprise)',
  company_projects: 'Projets (entreprise)',
  company_orders: 'Commandes (entreprise)',
  company_tickets: 'Support (entreprise)',
  company_discovery_forms: 'System builder (entreprise)',
  company_factures: 'Factures (entreprise)',
  company_abonnements: 'Abonnements (entreprise)',
  company_envois: 'Envois (entreprise)',
  company_tasks: 'Tâches (entreprise)',
  company_achats: 'Achats (entreprise)',
  company_retours: 'Retours (entreprise)',
  contact_tasks: 'Tâches (contact)',
  order_envois:   'Envois (commande)',
  adresse_envois: 'Envois (adresse)',
  abonnements:    'Abonnements',
  abonnement_events: "Mouvements d'abonnements",
  assemblages:    'Assemblages',
  shipments:      'Envois',
  shipment_items: "Articles d'envoi",
  employees:      'Employés',
  paies:          'Paies',
  paie_items:     'Items de paie',
  stock_movements: "Mouvements d'inventaire",
  achats_fournitures: 'Achats de fournitures',
  fournitures:    'Fournitures',
  fourniture_achats: 'Achats (fourniture)',
  product_movements: "Mouvements de stock (produit)",
  product_purchases: 'Achats (pièce)',
  product_used_in: 'Utilisé dans (pièce)',
  sync_log: 'Journal de synchronisation',
  journal_entries: 'Écritures de journal',
  stripe_payouts: 'Versements Stripe',
  marketing_forms: 'Formulaires',
  marketing_form_submissions: 'Soumissions (formulaire)',
  marketing_form_script_runs: 'Déclenchements (formulaire)',
  stripe_invoice_items: 'Items vendus',
  automations:    'Automations',
  soumissions:    'Soumissions',
  catalog:        'Catalogue de produits',
  users:          'Utilisateurs',
  bom_items:      'BOM',
  qualification_calls: 'Appels de qualification',
  discovery_forms: 'System builder',
  public_files: 'Fichiers publics',
  sale_receipts: 'Extraction de données',
  activity_log: 'Feed des opérations',
  changelog: 'Nouveautés',
  activity_codes: "Codes d'activité",
  ops_issues: "Problèmes d'opérations",
  payments: 'Paiements',
  bank_transactions: 'Transactions bancaires',
  revenus_reportes: "Revenus perçus d'avance",
  travaux_prompts: 'Travaux',
}

// Chaque entrée : { id, label, field, type?, options?, sortable?, filterable?, groupable?, defaultVisible?, description? }
// type: 'text' (défaut) | 'number' | 'date' | 'boolean' | 'single_select'
// description : texte court (provenance, unité ou calcul d'un champ). Affiché
// via une infobulle « ? » dans l'en-tête de colonne (voir ColumnHelp dans
// Les 18 colonnes de permissions des contrôleurs centraux (« Info permissions CC »
// et les sommes company_max_*) ont été retirées le 2026-09-03 : leurs champs sont
// supprimés sur companies comme sur contacts, le portier les masquait donc partout.
// Les colonnes SQL et leur calcul serveur (utils/ccPermissions.js) restent intacts.

// Nom du TYPE d'une colonne dont le rendu sur-mesure est un lien vers la fiche
// d'un autre record. Dans Airtable, « enregistrement lié » est un type, pas un
// rendu caché : nommer ainsi le type d'origine rend le re-typage lisible (on
// voit ce qu'on perd) et réversible (on peut le re-sélectionner).
//
// N'est appliqué que si la colonne porte réellement un `render` — la même clé
// existe sur des tables où elle n'est que du texte, et promettre un lien
// inexistant serait pire que de ne rien dire.
// Nom d'UNE fiche de la table, pour les libellés au singulier (« Lien vers
// Entreprise » — TABLE_LABELS dit « Entreprises », qui nomme la liste). Seules
// les tables qui s'écartent d'un simple TABLE_LABELS sans « s » y figurent.
export const TABLE_RECORD_LABELS = {
  companies:      'Entreprise',
  contacts:       'Contact',
  projects:       'Projet',
  orders:         'Commande',
  products:       'Produit',
  purchases:      'Achat',
  tickets:        'Billet',
  serial_numbers: 'Numéro de série',
  shipments:      'Envoi',
  returns:        'Retour',
  adresses:       'Adresse',
  factures:       'Facture',
  soumissions:    'Soumission',
  employees:      'Employé',
  users:          'Utilisateur',
  ops_issues:     'Problème',
}

export const LINKED_RECORD_TYPE_LABELS = {
  company_name: 'Lien vers Entreprise',
  contact_name: 'Lien vers Contact',
  product_name: 'Lien vers Produit',
  order_number: 'Lien vers Commande',
  project_name: 'Lien vers Projet',
}

// Choix du champ « Type » de la table Airtable des mouvements d'inventaire,
// dans l'ordre de la base.
export const STOCK_MOVEMENT_TYPES = [
  'Fabrication', 'Utilisation pour le reconditionnement', 'Prélèvement pour R&D', 'Restitution R&D',
  'Ajustement (diminution)', 'Ajustement (augmentation)', 'Utilisation de pièces usagés',
]

// Couleurs de ces choix dans Airtable.
export const STOCK_MOVEMENT_TYPE_COLORS = {
  'Fabrication': 'blue',
  'Utilisation pour le reconditionnement': 'indigo',
  'Prélèvement pour R&D': 'orange',
  'Restitution R&D': 'orange',
  'Ajustement (diminution)': 'yellow',
  'Ajustement (augmentation)': 'yellow',
  'Utilisation de pièces usagés': 'teal',
}

// Quantité signée, comme « Changement » dans Airtable : le sens (colonne `type`)
// n'est plus affiché ailleurs.
export const stockMovementSignedQty = row =>
  (row.type === 'out' || (row.type === 'adjustment' && /diminution/i.test(row.reason || ''))) ? -row.qty : row.qty

export const TABLE_COLUMN_META = {
  // Feed des opérations — journal d'activité (qui / quoi / quand). Lecture seule.
  // Les options single_select reflètent les valeurs brutes émises par
  // emitEntity/emitOrder/emitCompany (server/src/services/realtimeEmitters.js) ;
  // l'affichage FR est géré par les render() de ActivityFeed.jsx.
  activity_log: [
    { id: 'created_at',  label: 'Quand',        field: 'created_at',  type: 'date' },
    { id: 'user_name',   label: 'Qui',          field: 'user_name',   type: 'user' },
    { id: 'action',      label: 'Action',       field: 'action',      type: 'single_select', options: ['created', 'updated', 'deleted'] },
    { id: 'entity_type', label: 'Type',         field: 'entity_type', type: 'single_select', options: ['order', 'company', 'contact', 'product', 'ticket', 'task', 'project', 'interaction', 'soumission', 'call', 'purchase', 'facture', 'sale_receipt', 'timesheet', 'employee', 'paie', 'activity_code', 'shipment', 'adresse', 'vacation', 'achat_fournisseur'] },
    { id: 'detail',      label: 'Enregistrement', field: 'detail' },
  ],

  // Journal des nouveautés (/changelog) — lignes construites à partir de
  // client/src/data/changelog.json, une par entrée. `type` = nature dominante
  // de l'entrée (nouveauté > amélioration > correction) ; le détail complet des
  // changements s'ouvre en dépliant la ligne. `requester` vient du seul champ
  // `requester` de l'entrée : le nom porté par la demande d'origine (la file de
  // travaux le joint au brief, voir services/promptQueue.js → briefFor). Vide
  // quand la demande ne vient de personne — aucune déduction.
  changelog: [
    { id: 'date',      label: 'Date',       field: 'date',      type: 'date' },
    { id: 'title',     label: 'Nouveauté',  field: 'title' },
    { id: 'category',  label: 'Domaine',    field: 'category',  type: 'single_select' },
    { id: 'type',      label: 'Nature',     field: 'type',      type: 'single_select', options: ['Nouveauté', 'Amélioration', 'Correction'] },
    { id: 'requester', label: 'Demandé par', field: 'requester', type: 'user' },
    { id: 'summary',   label: 'Détail',     field: 'summary' },
  ],

  // File de travaux (/travaux) — items du store de l'agent. `section` (File /
  // Complété) et `ordre` (rang dans la file) sont dérivés côté client : ce sont
  // eux que filtrent et trient les deux vues par défaut (server/src/db/schema.js).
  travaux_prompts: [
    { id: 'etat',            label: 'État',     field: 'etat', width: 130 },
    { id: 'title',           label: 'Titre',    field: 'title', width: 420 },
    { id: 'created_by_name', label: 'Par',      field: 'created_by_name', width: 150 },
    { id: 'page',            label: 'Page',     field: 'page', width: 160 },
    { id: 'model',           label: 'Modèle',   field: 'model_label', width: 100 },
    { id: 'created_at',      label: 'Créé',    field: 'created_at', type: 'date', width: 120 },
    { id: 'completed_at',    label: 'Terminé',  field: 'completed_at', type: 'date', width: 120 },
    { id: 'duree',           label: 'Temps',    field: 'duree', type: 'number', width: 110 },
    { id: 'section',        label: 'Section',  field: 'section', type: 'single_select', options: ['File', 'Complété'], defaultVisible: false },
    { id: 'ordre',           label: 'Rang',     field: 'ordre', type: 'number', defaultVisible: false },
  ],

  // Revenus perçus d'avance (/revenus-reportes) — lignes calculées par le
  // serveur pour le mois choisi, pas une table de la base. Les montants sont en
  // CAD, convertis au taux de l'encaissement.
  // Dépôts du compte 23900 : un dossier par client ou par facture. Le solde est
  // la colonne qui compte — le reste explique d'où il vient.
  revenus_reportes: [
    { id: 'company_name',    label: 'Client',        field: 'company_name', width: 240 },
    { id: 'last_date',       label: 'Dernier mouvement', field: 'last_date', type: 'date', width: 150 },
    { id: 'encaisse',        label: 'Encaissé',      field: 'encaisse', type: 'number' },
    { id: 'libere',          label: 'Libéré',        field: 'libere', type: 'number' },
    { id: 'solde',           label: 'Solde',         field: 'solde', type: 'number' },
    { id: 'etat',            label: 'État',          field: 'etat', type: 'single_select', options: ['À constater', 'Anomalie', 'Réglé'] },
    { id: 'document_number', label: 'Facture',       field: 'document_number', width: 150, defaultVisible: false },
    { id: 'versements',      label: 'Versements',    field: 'versements', type: 'number', defaultVisible: false },
    { id: 'first_date',      label: 'Premier mouvement', field: 'first_date', type: 'date', defaultVisible: false },
  ],

  // Codes d'activité — page de gestion (feuilles de temps). Édition inline via
  // render() custom dans CodesActivite.jsx ; `shared_with` est un champ dérivé
  // (noms des users assignés, ou « Tous les employés ») pour la recherche.
  activity_codes: [
    { id: 'name',         label: 'Nom',          field: 'name' },
    { id: 'shared_with',  label: 'Partagé avec', field: 'shared_with', sortable: false, groupable: false, filterable: false },
    { id: 'payable',      label: 'Payable',      field: 'payable',      type: 'boolean' },
    { id: 'rsde_default', label: 'RSDE',         field: 'rsde_default', type: 'boolean' },
    { id: 'active',       label: 'Actif',        field: 'active',       type: 'boolean' },
    { id: 'created_at',   label: 'Créé le',      field: 'created_at',   type: 'date', defaultVisible: false },
  ],

  // Problèmes d'opérations — journal des incidents du quotidien (assemblage,
  // expédition, réception…). `reported_by_name` est joint côté page depuis le
  // cache des utilisateurs, comme l'assignation d'un billet.
  ops_issues: [
    { id: 'occurred_at',      label: 'Date',        field: 'occurred_at', type: 'date' },
    { id: 'title',            label: 'Problème',    field: 'title' },
    { id: 'area',             label: 'Secteur',     field: 'area',     type: 'single_select', options: OPS_AREAS },
    { id: 'severity',         label: 'Gravité',     field: 'severity', type: 'single_select', options: OPS_SEVERITIES },
    { id: 'status',           label: 'Statut',      field: 'status',   type: 'single_select', options: OPS_STATUSES },
    { id: 'reported_by_name', label: 'Signalé par', field: 'reported_by_name', type: 'user' },
    { id: 'description',      label: 'Détails',     field: 'description', defaultVisible: false },
    { id: 'resolution',       label: 'Correctif',   field: 'resolution',  defaultVisible: false },
    { id: 'resolved_at',      label: 'Résolu le',   field: 'resolved_at', type: 'date', defaultVisible: false },
    { id: 'created_at',       label: 'Créé le',     field: 'created_at',  type: 'date', defaultVisible: false },
  ],

  tasks: [
    { id: 'title',         label: 'Titre',        field: 'title' },
    { id: 'type',          label: 'Type',         field: 'type',          type: 'single_select', options: ['Problème'] },
    { id: 'status',        label: 'Statut',       field: 'status',        type: 'single_select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'] },
    { id: 'priority',      label: 'Priorité',     field: 'priority',      type: 'single_select', options: ['Basse', 'Normal', 'Haute', 'Urgente'] },
    { id: 'due_date',      label: 'Échéance',     field: 'due_date',      type: 'date' },
    { id: 'company_name',  label: 'Entreprise',   field: 'company_name',  defaultVisible: true  },
    { id: 'contact_name',  label: 'Contact',      field: 'contact_name',  defaultVisible: true  },
    // « Billet » (ticket_title) retirée : c'était un lookup sur `tickets.title`,
    // droppée (migration 040). Le lien vers le billet reste sur la fiche tâche.
    { id: 'assigned_name', label: 'Responsable',  field: 'assigned_name', type: 'user', defaultVisible: false },
    { id: 'created_at',    label: 'Créée le',     field: 'created_at',    type: 'date', defaultVisible: false },
  ],

  companies: [
    // « Contacts » (contacts_count) retirée le 2026-09-03 : champ supprimé.
    // « Type » et « Téléphone » retirées le 2026-09-07 : colonnes droppées
    // (migration 045), comme « URL » (site web) sur la fiche.
    { id: 'name',            label: 'Entreprise',   field: 'name' },
    { id: 'city',            label: 'Ville',        field: 'city' },
    { id: 'lifecycle_phase', label: 'Phase',        field: 'lifecycle_phase', type: 'single_select', options: ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore'] },
  ],

  contacts: [
    // « Adresse de livraison » (has_shipping_address) retirée le 2026-09-03 :
    // champ supprimé. La colonne SQL et son calcul serveur restent.
    //
    // Plus aucun de ces champs n'est « codé en dur » au sens du mapping : les 6
    // clés du field_map cœur du CRM (Prénom, Nom, Email, Phone number,
    // Entreprise, Langue) ont été reprises dans /champs/contacts et les
    // colonnes adoptées en champs personnalisés (migration 044,
    // nativeFieldConversions.js). Ce qui reste ici est le RENDU et la
    // visibilité par défaut — « Prénom Nom » sur une seule cellule, le lien
    // vers l'entreprise, la pastille de langue — que le registre ne sait pas
    // porter. Les libellés, eux, viennent des champs (DataTable.relabeled).
    //
    // L'id de la colonne de nom est celui de sa colonne SQL (`last_name`) et
    // plus `full_name` : le champ personnalisé porte forcément le nom de la
    // colonne, et deux ids différents auraient donné deux colonnes « Nom ».
    { id: 'last_name',    label: 'Nom',         field: 'last_name' },
    { id: 'first_name',   label: 'Prénom',      field: 'first_name', defaultVisible: false },
    // La colonne affichée est le nom joint de l'entreprise, la colonne
    // réellement importée est la FK : `mappingColumn` rattache la cellule
    // « Champ Airtable » de /champs/contacts à `company_id` (même geste que
    // « Produit » des assemblages), plutôt que d'adopter la FK — ce qui
    // afficherait des ids bruts et casserait le picker d'entreprise.
    { id: 'company_name', label: 'Entreprise',  field: 'company_name', mappingColumn: 'company_id' },
    { id: 'email',        label: 'Courriel',    field: 'email' },
    { id: 'phone',        label: 'Téléphone',   field: 'phone',  type: 'phone' },
    { id: 'mobile',       label: 'Cellulaire',  field: 'mobile', type: 'phone', defaultVisible: false },
    { id: 'language',     label: 'Langue',      field: 'language',  type: 'single_select', options: ['French', 'English'] },
  ],

  projects: [
    // Retirées le 2026-09-03 (champs supprimés) : « Valeur (CAD) » (value_cad),
    // « Mensuel (CAD) » (monthly_cad), « Commandes » (orders) et « Vendeur AT »
    // (nom_du_vendeur). Les colonnes SQL et la page Pipeline (servie par l'API,
    // pas par le cache) continuent de les lire.
    // « Projet » (le numéro, PRJ-1637) n'est plus une définition : c'est un
    // CHAMP (custom_fields kind='data', colonne `name`, cf.
    // nativeFieldConversions.js). Son libellé, son type et sa suppression se
    // règlent dans /champs/projects ; ce qui reste ici est sa place dans le
    // tableau.
    { id: 'name',           label: 'Projet',            field: 'name' },
    // La colonne affichée est le NOM de l'entreprise (jointure), mais la colonne
    // réellement importée est la FK : `mappingColumn` rattache la cellule
    // « Champ Airtable » de /champs/projects à `company_id`, que le champ
    // Airtable « Client final » alimente.
    { id: 'company_name',   label: 'Entreprise',        field: 'company_name', mappingColumn: 'company_id' },
    { id: 'type',           label: 'Type',              field: 'type',        type: 'single_select', options: ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange'] },
    // Le champ « Statut » a été retiré (signalement depuis /champs/projects) :
    // la colonne SQL `projects.status` et les routes qui la lisent restent en
    // place, mais elle ne s'affiche plus nulle part dans l'interface.
    { id: 'probability',    label: 'Probabilité',       field: 'probability', type: 'number', defaultVisible: false },
    { id: 'nb_greenhouses', label: 'Nb serres',         field: 'nb_greenhouses', type: 'number', defaultVisible: false },
    // « Vendeur » est calculé depuis `vendeur_ref` : c'est cette colonne-là que
    // le mapping Airtable alimente (le nom importé y est résolu en employé ou
    // entreprise) — d'où `mappingColumn`, qui rattache la cellule « Champ
    // Airtable » de /champs/projects à la bonne colonne ERP.
    { id: 'vendeur_label',  label: 'Vendeur',           field: 'vendeur_label', mappingColumn: 'vendeur_ref' },
    { id: 'close_date',     label: 'Date de clôture',  field: 'close_date',  type: 'date' },
    // « Raison du refus » n'est plus un champ natif : la colonne SQL a été
    // droppée (migration 025) et le champ vit comme champ PERSONNALISÉ
    // (`raison_du_refus`, liste de choix miroir d'Airtable) — il arrive donc
    // tout seul dans les tableaux et les fiches via custom_fields.
    { id: 'notes',          label: 'Notes',            field: 'notes',       defaultVisible: false },
    { id: 'creation',       label: 'Créé le',          field: 'creation',    type: 'date', defaultVisible: false },
    { id: 'updated_at',     label: 'Modifié le',       field: 'updated_at',  type: 'date', defaultVisible: false },
  ],

  // Colonnes de la table products. Ce ne sont PLUS des définitions : chacune a
  // désormais son champ dans le registre (custom_fields kind='data', semé par
  // services/nativeFieldConversions.js), donc son libellé, son type et sa
  // suppression se règlent dans /champs/products. Ce qui reste ici est le RENDU
  // et la visibilité par défaut — la vignette d'image, l'ordre d'apparition —
  // que le registre ne sait pas porter. Les champs Airtable dynamiques
  // s'ajoutent en plus, via /api/views/products.
  products: [
    // Rendu vignette : render() custom dans Products.jsx (pattern Purchases).
    { id: 'image_url', label: 'Image',                  field: 'image_url', sortable: false, filterable: false, groupable: false },
    { id: 'name_fr',   label: 'Nom',                    field: 'name_fr' },
    { id: 'name_en',   label: 'Nom (EN)',               field: 'name_en',   defaultVisible: false },
    { id: 'sku',       label: 'SKU',                    field: 'sku' },
    { id: 'type',      label: 'Type',                   field: 'type' },
    { id: 'unit_cost', label: 'Coût unitaire',          field: 'unit_cost', type: 'currency', defaultVisible: false },
    { id: 'price_cad', label: 'Prix (CAD)',             field: 'price_cad', type: 'currency', defaultVisible: false },
    { id: 'stock_qty', label: 'Quantité en inventaire', field: 'stock_qty', type: 'number' },
    { id: 'min_stock', label: 'Stock minimum',          field: 'min_stock', type: 'number', defaultVisible: false },
    // « Qté à cmd » (≠ « Quantité à commander ») : le champ Airtable
    // quantite_a_commander porte déjà ce label — une collision de label le
    // ferait disparaître du merge de useTableView (les pills y réfèrent).
    { id: 'order_qty', label: 'Qté à cmd',              field: 'order_qty', type: 'number', defaultVisible: false },
    { id: 'supplier',  label: 'Fournisseur',            field: 'supplier',  defaultVisible: false },
    { id: 'is_sellable', label: 'Vendable',             field: 'is_sellable', type: 'boolean', defaultVisible: false },
    // Permet d'isoler les fiches sans équivalent Airtable (filtre « Est vide »).
    { id: 'airtable_id', label: 'ID Airtable',          field: 'airtable_id', defaultVisible: false },
  ],

  orders: [
    { id: 'order_number',   label: '# Commande',       field: 'order_number'  },
    { id: 'company_name',   label: 'Entreprise',        field: 'company_name'  },
    { id: 'date_commande',  label: 'Date de commande',  field: 'date_commande', type: 'date' },
    { id: 'status',         label: 'Statut',            field: 'status',   type: 'single_select', options: ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'Drop ship seulement', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'] },
    // « Priorité » n'est plus déclarée ici : c'est un CHAMP PERSO (custom_fields,
    // kind='data', colonne `priority`, cf. nativeFieldConversions.js). Ses choix,
    // ses couleurs et son libellé s'éditent dans l'app ; la colonne arrive dans
    // le tableau par la fusion des champs perso (DataTable.columnsWithOwnCf).
    { id: 'items_count',    label: 'Items',             field: 'items_count', type: 'number', groupable: false, sortable: false },
    { id: 'assigned_name',  label: 'Assigné à',         field: 'assigned_name', type: 'user', defaultVisible: false },
  ],

  // Lignes d'articles d'une commande — tableau embarqué dans OrderDetail.jsx
  // (les render() custom — produit, badges, actions — vivent dans la page).
  order_items: [
    // Colonne de LIEN vers le produit : elle porte `product_id` (l'id du record
    // produit) et affiche son NOM, cliquable vers la fiche produit — le render
    // vit dans OrderDetail.jsx, comme les autres. C'est le champ « Produit »
    // (clé cœur `product`) de /champs/order_items, à ne pas confondre avec
    // l'ancienne colonne texte `product_name`, supprimée le 2026-09-03 et
    // laissée à la corbeille.
    // Tri / filtre / groupement désactivés : la valeur brute est un id, s'en
    // servir pour ordonner ou filtrer n'aurait aucun sens pour l'utilisateur.
    // La recherche du tableau porte déjà sur le nom du produit et le SKU.
    { id: 'product_id', label: 'Produit', field: 'product_id', sortable: false, filterable: false, groupable: false },
    { id: 'qty',                label: 'Qté',             field: 'qty', type: 'number' },
    { id: 'item_type',          label: 'Type',            field: 'item_type', type: 'single_select', options: ['Facturable', 'Remplacement', 'Non facturable'] },
    { id: 'fulfillment_status', label: 'Prélèvement',     field: 'fulfillment_status', type: 'single_select', options: ['À prélever', 'Prélevé', "Dans l'envoi", 'Envoyé', 'En attente'] },
    // « Série remplacée » (colonne replaced_serial) retirée le 2026-09-03 :
    // redondante avec le champ Airtable « # de série remplacé » (de_serie_remplace),
    // seul conservé. La colonne SQL et son écriture serveur (retours) restent.
    // « Coût unitaire actuel » supprimé définitivement (migration 068).
    // Le coût des articles reste consultable au moment de l’envoi.
    // « Notes » (colonne notes) retirée le 2026-09-03 : les notes se prennent sur
    // la commande, pas ligne par ligne. Colonne SQL et écritures serveur intactes.
    // Retirées le 2026-09-03 (champs supprimés) : « Produit » (product_name —
    // remplacée par la colonne de lien `product_id` ci-dessus),
    // « Emplacement » (product_location), « N° de série » (serials),
    // « Disponibilité » (product_stock) et « Actions ». Colonnes SQL intactes.
  ],

  // Envois listés dans la fiche d'une commande. `items_summary` / `serials_summary`
  // sont dérivés côté page (articles rattachés à l'envoi + leurs numéros de série).
  order_envois: [
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    { id: 'status',          label: 'Statut',       field: 'status', type: 'single_select', options: ['À envoyer', 'Envoyé'] },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at', type: 'date' },
    { id: 'items_summary',   label: 'Articles',     field: 'items_summary', sortable: false, groupable: false },
    { id: 'serials_summary', label: 'N° de série',  field: 'serials_summary', sortable: false, groupable: false },
    { id: 'pays',            label: 'Pays',         field: 'pays', defaultVisible: false },
    { id: 'notes',           label: 'Notes',        field: 'notes', defaultVisible: false },
    { id: 'created_at',      label: 'Créé le',      field: 'created_at', type: 'date', defaultVisible: false },
  ],

  // Envois expédiés à une adresse (fiche adresse). Pas de colonne « Adresse » :
  // toutes les lignes partagent celle de la fiche.
  adresse_envois: [
    { id: 'order_number',    label: '# Commande',   field: 'order_number' },
    { id: 'company_name',    label: 'Entreprise',   field: 'company_name' },
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'status',          label: 'Statut',       field: 'status', type: 'single_select', options: ['À envoyer', 'Envoyé'] },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at', type: 'date' },
    { id: 'pays',            label: 'Pays',         field: 'pays', defaultVisible: false },
    { id: 'notes',           label: 'Notes',        field: 'notes', defaultVisible: false },
    { id: 'created_at',      label: 'Créé le',      field: 'created_at', type: 'date', defaultVisible: false },
  ],

  // Colonnes NATIVES restantes d'un billet. Titre, question, réponse, type,
  // statut, durée, date, entreprise et contact ont été supprimés sur demande
  // (colonnes droppées, migration 040). Tout ce qui décrit encore un billet vit
  // dans les champs personnalisés de la table : ils s'ajoutent d'eux-mêmes aux
  // colonnes (cf. useTableView) et se règlent depuis /champs/tickets.
  tickets: [
    { id: 'assigned_name', label: 'Assigné à',  field: 'assigned_name', type: 'user' },
    { id: 'survey_rating', label: 'Satisfaction', field: 'survey_rating', type: 'rating', defaultVisible: false },
  ],

  // Colonnes NATIVES restantes d'un achat. Produit, SKU, image, référence,
  // dates, quantité commandée et prix unitaire ont été supprimés sur demande
  // (colonnes droppées, migration 035), après « Fournisseur »/« Statut » (032),
  // « Date prévue » (029), et « Qté reçue » (036). Tout ce qui décrit encore un
  // achat vit dans les champs personnalisés de la table : ils s'ajoutent d'eux-
  // mêmes aux colonnes (cf. useTableView) et se règlent depuis /champs/purchases.
  purchases: [
    { id: 'emplacement',   label: 'Emplacement', field: 'emplacement' },
  ],

  // Tableau « Achats » d'une fiche pièce. `purchases.product_id` étant droppée
  // (migration 035), le rattachement passe par le champ lien `nom_de_la_piece`
  // (côté serveur : GET /products/:id/purchases). Les colonnes reprises ici sont
  // les champs VIVANTS d'un achat — les prix ont été mis à la corbeille le
  // 2026-09-06, on ne les ressuscite pas ici. Le reste du catalogue purchases
  // reste PROPOSÉ dans le sélecteur de champs (tableau encastré).
  product_purchases: [
    // « Achat » (code LIA) : le champ « ID » de /champs/purchases est purgé,
    // mais ce tableau le garde (keepDeleted, cf. mergedColumns, DataTable.jsx).
    { id: 'at_id',                        label: 'Achat',       field: 'at_id', keepDeleted: true },
    { id: 'date_de_commande',             label: 'Commandé',    field: 'date_de_commande', type: 'date' },
    { id: 'quantite_commande',            label: 'Qté',         field: 'quantite_commande', type: 'number' },
    // Calculé par GET /products/:id/purchases (override payé, sinon facturé).
    { id: 'prix_unitaire',                label: 'Prix unitaire', field: 'prix_unitaire', type: 'number' },
    // Calculé par GET /products/:id/purchases : quantité de l'achat encore en
    // stock selon le FIFO (vide = lot épuisé).
    { id: 'fifo_qty',                     label: 'En stock',    field: 'fifo_qty', type: 'number' },
    { id: 'supplier',                    label: 'Fournisseur', field: 'supplier_company_name' },
    { id: 'cf_date_de_reception_complete', label: 'Reçu',       field: 'cf_date_de_reception_complete', type: 'date' },
    // Champ « Créé par » de /champs/purchases (auteur de la création dans
    // l'ERP ; vide pour les achats créés dans Airtable).
    { id: 'cf_cree_par',                  label: 'Créé par',    field: 'cf_cree_par' },
  ],

  // Numéros de série : plus AUCUN champ codé en dur. Les 7 colonnes ci-dessous
  // sont ADOPTÉES en champs (custom_fields, cf. nativeFieldConversions.js), qui
  // portent désormais leur libellé, leur type et leur suppression ; les entrées
  // survivent comme PORTEUSES DU RENDU (n° monospace, liens produit/entreprise,
  // grille de permissions) et de la visibilité par défaut.
  // « Produit » et « Entreprise » affichent un libellé JOINT alors que la
  // colonne importée est la FK : `mappingColumn` rattache la cellule « Champ
  // Airtable » de /champs/serial_numbers à la colonne que le sync remplit.
  serial_numbers: [
    { id: 'serial',        label: 'Numéro de série', field: 'serial' },
    { id: 'product_name',  label: 'Produit',         field: 'product_name', mappingColumn: 'product_id' },
    { id: 'company_name',  label: 'Entreprise',      field: 'company_name', mappingColumn: 'company_id' },
    // Les choix du « Statut » vivent sur le CHAMP (custom_fields), pas ici :
    // c'est lui que la modale « Modifier le champ » édite, et la colonne en
    // hérite (libellés, ordre et couleurs).
    { id: 'status',        label: 'Statut',          field: 'status', type: 'single_select' },
    { id: 'address',       label: 'Adresse',         field: 'address', defaultVisible: false },
    { id: 'permissions',   label: 'Permissions',     field: 'permissions', sortable: false, filterable: false, groupable: false, defaultVisible: false },
    { id: 'manufacture_date', label: 'Date fab.',    field: 'manufacture_date', type: 'date', defaultVisible: false },
  ],

  interactions: [
    { id: 'type',         label: 'Type',        field: 'type',      type: 'single_select', options: ['call', 'email', 'meeting', 'note', 'sms'] },
    { id: 'direction',    label: 'Direction',   field: 'direction', type: 'single_select', options: ['inbound', 'outbound'] },
    { id: 'contact_name', label: 'Contact',     field: 'contact_name'  },
    { id: 'company_name', label: 'Entreprise',  field: 'company_name'  },
    { id: 'phone_number', label: 'Téléphone',   field: 'phone_number',     defaultVisible: false },
    { id: 'subject',      label: 'Objet',       field: 'subject'  },
    { id: 'summary',      label: 'Résumé',      field: null,               sortable: false, filterable: false, groupable: false },
    { id: 'timestamp',    label: 'Date',        field: 'timestamp',        type: 'date' },
    { id: 'duration_seconds', label: 'Durée',   field: 'duration_seconds', type: 'number', defaultVisible: false },
    { id: 'user_name',    label: 'Utilisateur', field: 'user_name',        type: 'user', defaultVisible: false },
  ],

  retours: [
    // « N° de retour », « Entreprise », « Contact », « Statut du problème »,
    // « Notes » et « Facturé le » retirés : colonnes droppées, cf. migration
    // serveur 037 (comme « Suivi » et « Statut de traitement » l'ont été par
    // la 028), et « Statut » par la 041. Les champs Airtable des retours se
    // pilotent tous depuis /champs/retours.
    { id: 'created_at',        label: 'Date',                 field: 'created_at', type: 'date' },
  ],

  // Articles d'un retour (tableau « Articles » de la fiche retour, clé de vue
  // `retour_items`). Les colonnes listées ici sont les colonnes PHYSIQUES de
  // return_items (plus les libellés joints par la route : n° de série, nom du
  // produit, SKU) ; les 46 champs Airtable de la table restent proposés par le
  // sélecteur de champs sans s'afficher d'office.
  // Deux colonnes affichent un libellé JOINT (n° de série, produit à recevoir)
  // alors que la colonne réellement importée est la FK :
  // `mappingColumn` rattache la cellule « Champ Airtable » de /champs/return_items
  // à cette FK-là, sinon la ligne du libellé et celle de la FK feraient deux
  // lignes homonymes. « Retour » (`return_id`) et « Entreprise » (`company_id`)
  // n'ont aucune colonne affichée : elles prennent leur propre ligne, comme
  // toute colonne mappée que le tableau ne montre pas.
  // « Qté » a été droppée (migration 046) : un article de retour vaut une unité.
  // « Produit à envoyer » aussi (migration 046) : la FK `product_send_id` qu'elle
  // affichait n'existe plus.
  return_items: [
    { id: 'serial_number',  label: 'N° de série',   field: 'serial_number', mappingColumn: 'serial_id' },
    { id: 'product_name',   label: 'Produit reçu',  field: 'product_name' },
    { id: 'sku',            label: 'SKU',           field: 'sku' },
    { id: 'return_reason',  label: 'Raison',        field: 'return_reason' },
    { id: 'action',         label: 'Action',        field: 'action' },
    { id: 'received_at',    label: 'Reçu le',       field: 'received_at', type: 'date' },
    { id: 'product_to_receive', label: 'Produit à recevoir', field: 'product_to_receive', mappingColumn: 'product_id' },
    { id: 'return_reason_notes', label: 'Précisions',            field: 'return_reason_notes',  defaultVisible: false },
    { id: 'problem_category',    label: 'Catégorie de problème', field: 'problem_category',     defaultVisible: false },
    { id: 'received_by',         label: 'Reçu par',              field: 'received_by',          defaultVisible: false },
    { id: 'analyzed_by',         label: 'Analysé par',           field: 'analyzed_by',          defaultVisible: false },
    { id: 'analysis_notes',      label: "Notes d'analyse",       field: 'analysis_notes',       defaultVisible: false },
    { id: 'created_at',          label: 'Créé le',               field: 'created_at', type: 'date', defaultVisible: false },
  ],

  factures: [
    { id: 'document_number',       label: 'N° document',       field: 'document_number' },
    { id: 'invoice_id',            label: 'ID Stripe/source',  field: 'invoice_id',            defaultVisible: false },
    { id: 'company_name',          label: 'Entreprise',        field: 'company_name'  },
    { id: 'customer_email',        label: 'Courriel client',   field: 'customer_email',        defaultVisible: false },
    { id: 'project_name',          label: 'Projet',            field: 'project_name',          defaultVisible: false  },
    { id: 'order_number',          label: 'Commande',          field: 'order_number',          defaultVisible: false  },
    { id: 'status',                label: 'Statut',            field: 'status',                type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',         label: 'Date document',     field: 'document_date',         type: 'date' },
    { id: 'payment_date',          label: 'Date de paiement',  field: 'payment_date',          type: 'date', defaultVisible: false },
    { id: 'payment_reference',     label: 'ID de paiement',    field: 'payment_reference',     defaultVisible: false, sortable: false },
    { id: 'due_date',              label: 'Échéance',          field: 'due_date',              type: 'date', defaultVisible: false },
    { id: 'currency',              label: 'Devise',            field: 'currency',              type: 'single_select', options: ['CAD', 'USD', 'EUR'], defaultVisible: false },
    { id: 'amount_before_tax_cad', label: 'Avant taxes (CAD)', field: 'amount_before_tax_cad', type: 'number' },
    { id: 'total_amount',          label: 'Total',             field: 'total_amount',          type: 'number' },
    { id: 'balance_due',           label: 'Solde dû',          field: 'balance_due',           type: 'number' },
    { id: 'refund_amount',         label: 'Remboursé',         field: 'refund_amount',         type: 'number', defaultVisible: false },
    { id: 'is_sent',               label: 'Envoyée',           field: 'is_sent',               type: 'boolean', defaultVisible: false },
    { id: 'deferred_revenue_state',label: 'Revenu reçu d\'avance', field: 'deferred_revenue_state', type: 'single_select', options: ['Constaté', 'En attente', '—'], defaultVisible: false },
    { id: 'notes',                 label: 'Notes',             field: 'notes' },
  ],

  payments: [
    { id: 'received_at',    label: 'Date',        field: 'received_at',   type: 'date' },
    { id: 'direction',      label: 'Type',        field: 'direction',     type: 'single_select', options: ['in', 'out'] },
    { id: 'method',         label: 'Méthode',     field: 'method',        type: 'single_select', options: ['stripe', 'cheque', 'virement_bancaire', 'interac', 'comptant', 'autre'] },
    { id: 'company_name',   label: 'Entreprise',  field: 'company_name'  },
    { id: 'document_number',label: 'Facture',     field: 'document_number' },
    { id: 'amount',         label: 'Montant',     field: 'amount',        type: 'number' },
    { id: 'currency',       label: 'Devise',      field: 'currency',      type: 'single_select', options: ['CAD', 'USD', 'EUR'], defaultVisible: false },
    { id: 'amount_cad',     label: 'Montant (CAD)', field: 'amount_cad',  type: 'number' },
    { id: 'qb_status',      label: 'QuickBooks',  field: 'qb_status', sortable: false, filterable: false },
    { id: 'notes',          label: 'Notes',       field: 'notes', defaultVisible: false },
  ],

  abonnements: [
    { id: 'company_name', label: 'Entreprise', field: 'company_name'  },
    { id: 'status',       label: 'Statut',     field: 'status', type: 'single_select', options: ['active', 'trialing', 'past_due', 'canceled', 'Actif', 'Inactif', 'Suspendu', 'Annulé', 'Expiré'] },
    { id: 'rachat',       label: 'Rachat',     field: 'rachat', defaultVisible: false },
    { id: 'amount_cad',   label: 'Montant (CAD)', field: 'amount_cad', type: 'number' },
    { id: 'start_date',   label: 'Début',      field: 'start_date', type: 'date' },
    { id: 'start_month',  label: 'Mois de début', field: 'start_month' },
    { id: 'end_date',     label: 'Fin',        field: 'end_date',   type: 'date', defaultVisible: false },
    { id: 'stripe_url',   label: 'Stripe',     field: 'stripe_url', defaultVisible: false, sortable: false },
  ],

  abonnement_events: [
    { id: 'event_date',          label: 'Date',           field: 'event_date',     type: 'date' },
    { id: 'month',               label: 'Mois',           field: 'month',          defaultVisible: false },
    { id: 'category',            label: 'Mouvement',      field: 'category',       type: 'single_select', options: ['creation', 'upgrade', 'downgrade', 'churn', 'reactivation'] },
    { id: 'company_name',        label: 'Entreprise',     field: 'company_name'  },
    { id: 'subscription_link',   label: 'Abonnement',     field: 'stripe_subscription_id', sortable: false, filterable: false, groupable: false },
    { id: 'amount_cad_delta',    label: 'Δ MRR (CAD)',    field: 'amount_cad_delta', type: 'number' },
    { id: 'rachat',              label: 'Rachat',         field: 'rachat_status', type: 'single_select', options: ['probable', 'confirmed', 'merged', 'none'], sortable: false },
    { id: 'previous_amount_cad', label: 'Avant (CAD)',    field: 'previous_amount_cad', type: 'number', defaultVisible: false },
    { id: 'new_amount_cad',      label: 'Après (CAD)',    field: 'new_amount_cad', type: 'number', defaultVisible: false },
    { id: 'currency',            label: 'Devise',         field: 'currency', type: 'single_select', options: ['CAD', 'USD'], defaultVisible: false },
  ],

  assemblages: [
    // « Produit » s'affiche depuis le nom joint, mais c'est `product_id` que le
    // mapping Airtable alimente — d'où `mappingColumn`, qui rattache la cellule
    // « Champ Airtable » de /champs/assemblages à la bonne colonne ERP.
    { id: 'product_name', label: 'Produit',         field: 'product_name', mappingColumn: 'product_id' },
    { id: 'sku',          label: 'SKU',             field: 'sku' },
    { id: 'qty_produced', label: 'Qté produite',    field: 'qty_produced', type: 'number' },
    { id: 'assembled_at', label: 'Date assemblage', field: 'assembled_at', type: 'date' },
  ],

  bom_items: [
    { id: 'component_image', label: 'Image',         field: 'component_image_url', sortable: false, filterable: false, groupable: false },
    // « Composant » et « Produit parent » s'affichent depuis le nom joint, mais
    // ce sont `component_id` / `product_id` que le mapping Airtable alimente —
    // d'où `mappingColumn`, qui rattache la cellule « Champ Airtable » de
    // /champs/bom_items à la bonne colonne ERP.
    // `linkTarget` : la colonne rend DÉJÀ un lien standard vers la fiche du
    // produit (depuis `component_id`, l'identifiant exact). Passer le champ en
    // « Lien vers Produit » ne remplace donc pas son rendu — cf.
    // applyFieldOverrides, lib/fieldOverrides.jsx.
    { id: 'component_name',  label: 'Composant',     field: 'component_name', mappingColumn: 'component_id', linkTarget: 'products' },
    { id: 'component_sku',   label: 'SKU composant', field: 'component_sku' },
    { id: 'qty_required',    label: 'Qté requise',   field: 'qty_required', type: 'number' },
    { id: 'component_stock_qty', label: 'Stock composant', field: 'component_stock_qty', type: 'number' },
    { id: 'buildable',       label: 'Assemblables',  field: 'buildable', type: 'number', sortable: false, filterable: false, groupable: false },
    { id: 'ref_des',         label: 'Ref. des.',     field: 'ref_des' },
    { id: 'product_name',    label: 'Produit parent', field: 'product_name', mappingColumn: 'product_id', linkTarget: 'products', defaultVisible: false  },
    { id: 'product_sku',     label: 'SKU parent',     field: 'product_sku',  defaultVisible: false },
  ],
  // Fiche pièce, section « Utilisé dans » : les lignes de BOM où la pièce est
  // composant, vues côté produit parent.
  product_used_in: [
    { id: 'product_image', label: 'Image',      field: 'product_image_url', sortable: false, filterable: false, groupable: false },
    { id: 'product_name',  label: 'Produit',    field: 'product_name', mappingColumn: 'product_id', linkTarget: 'products' },
    { id: 'product_sku',   label: 'SKU',        field: 'product_sku' },
    { id: 'qty_required',  label: 'Qté requise', field: 'qty_required', type: 'number' },
    { id: 'ref_des',       label: 'Ref. des.',  field: 'ref_des' },
  ],

  // Employés : les 28 champs de la table sont des CHAMPS PERSONNALISÉS
  // (custom_fields, kind='data' — cf. server/services/nativeFieldConversions.js).
  // Libellé, type, ordre, suppression et mapping Airtable se règlent dans
  // /champs/employees ; les colonnes arrivent dans le tableau par la fusion des
  // champs perso (DataTable.columnsWithOwnCf). Ne PAS redéclarer un champ ici :
  // la définition en dur reprendrait la main sur le type choisi dans l'app.
  //
  // Seule survivante, et pour son RENDU seulement : la colonne « Nom », qui
  // affiche une pastille d'initiales + « Prénom Nom » (le render vit dans
  // Employees.jsx). Elle est posée sur la colonne `last_name` — son id était
  // `full_name` jusqu'à la migration 038, qui l'a renommé dans les vues
  // enregistrées pour que le champ perso `last_name` ne fasse pas doublon.
  employees: [
    { id: 'last_name', label: 'Nom', field: 'last_name' },
  ],

  paies: [
    { id: 'number',                label: '#',                field: 'number', type: 'number' },
    { id: 'period_end',            label: 'Fin de période',   field: 'period_end', type: 'date' },
    { id: 'status',                label: 'Statut',           field: 'status', type: 'single_select', options: ['Non débuté','En cours','Complété','Envoyé'] },
    { id: 'items_count',           label: '# items',          field: 'items_count', type: 'number' },
    { id: 'total_regular_hours',   label: 'Heures rég.',      field: 'total_regular_hours', type: 'number' },
    { id: 'total_regular_amount',  label: '$ heures rég.',    field: 'total_regular_amount', type: 'number' },
    { id: 'total_with_charges_and_reimb', label: 'Total paie', field: 'total_with_charges_and_reimb', type: 'number' },
    { id: 'nb_holiday_days',       label: 'Congés fériés',    field: 'nb_holiday_days', type: 'number', defaultVisible: false },
    { id: 'timesheets_deadline',   label: 'Limite correction', field: 'timesheets_deadline', defaultVisible: false },
    { id: 'timesheets_sent',       label: 'FdT envoyées',     field: 'timesheets_sent', type: 'boolean', defaultVisible: false },
    { id: 'includes_hourly',       label: 'Inclut horaires',  field: 'includes_hourly', type: 'boolean', defaultVisible: false },
    { id: 'includes_mileage',      label: 'Inclut kilométrage', field: 'includes_mileage', type: 'boolean', defaultVisible: false },
    { id: 'includes_expense_reimb', label: 'Inclut remb. dép.', field: 'includes_expense_reimb', type: 'boolean', defaultVisible: false },
    { id: 'includes_paid_leave',   label: 'Inclut congés',    field: 'includes_paid_leave', type: 'boolean', defaultVisible: false },
    { id: 'includes_holiday_hours', label: 'Inclut fériés',   field: 'includes_holiday_hours', type: 'boolean', defaultVisible: false },
    { id: 'includes_sales_commissions', label: 'Inclut commissions', field: 'includes_sales_commissions', type: 'boolean', defaultVisible: false },
  ],

  paie_items: [
    { id: 'employee_name',  label: 'Employé',        field: 'last_name' },
    { id: 'period_end',     label: 'Fin de période', field: 'period_end', type: 'date' },
    { id: 'accounting_department', label: 'Département', field: 'accounting_department', type: 'single_select', options: ['R&D', 'Opérations', 'Marketing'] },
    { id: 'hourly_rate',    label: '$/h',            field: 'hourly_rate', type: 'number' },
    { id: 'regular_hours',  label: 'H. rég.',        field: 'regular_hours', type: 'number' },
    { id: 'holiday_hours',  label: 'H. fériées',     field: 'holiday_hours', type: 'number', defaultVisible: false },
    { id: 'vacation',       label: 'Vacances',       field: 'vacation', type: 'number', defaultVisible: false },
    { id: 'commission',     label: 'Commission',     field: 'commission', type: 'number' },
    { id: 'expense_reimb',  label: 'Remb. dépenses', field: 'expense_reimb', type: 'number', defaultVisible: false },
    { id: 'holiday_1_20',   label: 'Férié 1/20',     field: 'holiday_1_20', type: 'number' },
    { id: 'insurance_gains', label: 'Gains assur.',  field: 'insurance_gains', type: 'number' },
    { id: 'paid_leave',     label: 'Congés payés',   field: 'paid_leave' },
    { id: 'rsde_pct',       label: 'RSDE %',         field: 'rsde_pct', type: 'number', defaultVisible: false },
    { id: 'notes',          label: 'Notes',          field: 'notes', defaultVisible: false },
  ],

  achats_fournisseurs: [
    { id: 'type',             label: 'Type',          field: 'type',          type: 'single_select', options: ['bill','purchase'] },
    { id: 'date_achat',       label: 'Date',          field: 'date_achat',    type: 'date' },
    { id: 'vendor',           label: 'Fournisseur',   field: 'vendor' },
    { id: 'description',      label: 'Description',   field: 'description',   defaultVisible: false },
    { id: 'vendor_invoice_number', label: '# Fact. fourn.', field: 'vendor_invoice_number', defaultVisible: false },
    { id: 'bill_number',      label: '# Facture',     field: 'bill_number',   defaultVisible: false },
    { id: 'reference',        label: 'Référence',     field: 'reference',     defaultVisible: false },
    { id: 'category',         label: 'Catégorie',     field: 'category',      defaultVisible: false },
    { id: 'total_cad',        label: 'Total',         field: 'total_cad',     type: 'number' },
    { id: 'amount_paid_cad',  label: 'Payé',          field: 'amount_paid_cad', type: 'number', defaultVisible: false },
    { id: 'balance_due_cad',  label: 'Solde dû',      field: 'balance_due_cad', type: 'number' },
    { id: 'due_date',         label: 'Échéance',      field: 'due_date',      type: 'date', defaultVisible: false },
    { id: 'payment_method',   label: 'Paiement',      field: 'payment_method', defaultVisible: false },
    { id: 'status',           label: 'Statut',        field: 'status',        type: 'single_select', options: ['Brouillon','Soumis','Approuvé','Refusé','Remboursé','Reçue','Approuvée','Payée partiellement','Payée','En retard','Annulée'] },
    { id: 'qb',               label: 'QB',            field: 'quickbooks_id' },
  ],

  vendor_subscriptions: [
    { id: 'vendor',         label: 'Fournisseur',    field: 'vendor' },
    // Volontairement en 2e position : en bout de ligne le bouton tombait hors
    // écran (11 colonnes → défilement horizontal) et n'était donc visible que
    // dans la fiche.
    { id: 'actions',        label: 'Action',         field: 'actions',    sortable: false, filterable: false, groupable: false, alwaysVisible: true },
    { id: 'plan',           label: 'Plan/Forfait',   field: 'plan' },
    { id: 'currency',       label: 'Devise',         field: 'currency',   type: 'single_select', options: ['CAD', 'USD', 'Euro'] },
    { id: 'variable',       label: 'Fixe/Variable',  field: 'variable',   type: 'single_select', options: ['Fixe', 'Variable'] },
    { id: 'amount',         label: 'Montant av. taxes', field: 'amount',  type: 'number' },
    { id: 'taxes',          label: 'Taxes',          field: 'taxes',      type: 'single_select', options: ['TPS/TVQ', 'TPS', 'TVQ', 'Hors-champ'] },
    { id: 'frequency',      label: 'Fréquence',      field: 'frequency',  type: 'single_select', options: ['Mensuel', 'Annuel'] },
    { id: 'billing_label',  label: 'Date de facturation', field: 'billing_label' },
    { id: 'period',         label: 'Période',        field: 'period',     defaultVisible: false },
    { id: 'payment_method', label: 'Mode de paiement', field: 'payment_method' },
    { id: 'active',         label: 'Actif',          field: 'active',     type: 'single_select', options: ['Actif', 'Annulé'] },
    { id: 'comments',       label: 'Commentaires',   field: 'comments',   defaultVisible: false },
  ],

  vendor_profiles: [
    { id: 'name',                 label: 'Fournisseur',        field: 'name' },
    { id: 'qb_vendors',           label: 'Vendors QB',         field: 'qb_vendor_id_cad' },
    { id: 'default_qb_type',      label: 'Type d\'entité',     field: 'default_qb_type', type: 'single_select', options: ['purchase', 'bill', 'cc_credit'] },
    { id: 'expense_account',      label: 'Compte de dépense',  field: 'default_expense_account_id' },
    { id: 'payment_accounts',     label: 'Comptes de paiement', field: 'default_payment_account_id_cad' },
    { id: 'transaction_type',     label: 'Type de transaction', field: 'default_transaction_type' },
    { id: 'tax_codes',            label: 'Codes de taxe',      field: 'default_tax_code_id_cad' },
    { id: 'payment_terms_days',   label: 'Termes (jours)',     field: 'payment_terms_days', type: 'number' },
    { id: 'usual_currency',       label: 'Devise habituelle',  field: 'usual_currency', defaultVisible: false },
    { id: 'payment_method',       label: 'Mode de paiement',   field: 'payment_method', defaultVisible: false },
    { id: 'qb_category',          label: 'Catégorie ctb',      field: 'qb_category', defaultVisible: false },
    { id: 'description',          label: 'Description',        field: 'description', defaultVisible: false },
    { id: 'particularites',       label: 'Particularités',     field: 'particularites', defaultVisible: false },
    { id: 'active_subscriptions', label: 'Abonnements',        field: 'active_subscriptions', type: 'number', defaultVisible: false },
    { id: 'receipt_count',        label: 'Nb reçus',           field: 'receipt_count', type: 'number', defaultVisible: false },
    { id: 'last_receipt_date',    label: 'Dernier document',   field: 'last_receipt_date', type: 'date' },
    { id: 'notes',                label: 'Notes',              field: 'notes', defaultVisible: false },
  ],

  // Articles rattachés à un envoi — tableau embarqué dans EnvoisDetail.jsx.
  // Les lignes sont des order_items (mêmes champs custom) : la clé de vue
  // `shipment_items` garde ses propres vues/colonnes visibles, distinctes de
  // celles du tableau Articles de la commande (voir VIEW_KEY_TO_SQL_TABLE).
  shipment_items: [
    // Colonne de LIEN vers le produit (même champ que le tableau Articles de la
    // commande) : elle porte `product_id` et affiche le nom, cliquable. L'ancienne
    // colonne texte `product_name` a été supprimée le 2026-09-03 côté order_items
    // — la garder ici la faisait disparaître du sélecteur de colonnes.
    { id: 'product_id',       label: 'Produit',         field: 'product_id', sortable: false, filterable: false, groupable: false },
    { id: 'sku',              label: 'SKU',             field: 'sku' },
    { id: 'qty',              label: 'Qté',             field: 'qty', type: 'number' },
    // Pas de « Coût unitaire » ici non plus : ces lignes SONT des order_items
    // (voir VIEW_KEY_TO_SQL_TABLE) et le champ a été retiré le 2026-09-03.
    { id: 'line_weight_lbs',  label: 'Poids (lbs)',     field: 'line_weight_lbs', type: 'number' },
    { id: 'weight_lbs',       label: 'Poids unitaire (lbs)', field: 'weight_lbs', type: 'number', defaultVisible: false },
    { id: 'fulfillment_status', label: 'Prélèvement',   field: 'fulfillment_status', type: 'single_select', options: ['À prélever', 'Prélevé', "Dans l'envoi", 'Envoyé', 'En attente'], defaultVisible: false },
  ],

  shipments: [
    // Retirées le 2026-09-03 (champs supprimés) : « # Commande » (order_number),
    // « Entreprise » (company_name), « Pays » et « Créé le ». Colonnes SQL intactes.
    // Colonnes de LIEN (la colonne porte l'id du record visé, pas un libellé) :
    // ce sont les deux champs « Commande lié » et « Adresse de livraison »
    // importés d'Airtable. Masquées par défaut — le tableau montre déjà le
    // numéro de commande — mais listées dans le sélecteur de champs, sinon le
    // seul moyen de voir l'adresse d'un envoi était d'ouvrir sa fiche.
    { id: 'order_id',        label: 'Commande',     field: 'order_id',   defaultVisible: false },
    { id: 'address_id',      label: 'Adresse de livraison', field: 'address_id', defaultVisible: false },
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    // Lien de suivi chez le transporteur : champ DÉRIVÉ (transporteur + n° de
    // suivi, voir lib/trackingUrl.js), calculé sur la ligne dans Envois.jsx pour
    // être triable / filtrable / exportable comme un vrai champ. Aucune colonne
    // SQL : vide quand le transporteur n'a pas d'URL connue (cueillette sur
    // place, livraison en personne…).
    { id: 'tracking_url',    label: 'Lien de suivi', field: 'tracking_url', type: 'url' },
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at',  type: 'date' },
  ],

  bank_transactions: [
    { id: 'txn_date',     label: 'Date',        field: 'txn_date',    type: 'date', width: 104 },
    { id: 'description',  label: 'Libellé',     field: 'label' },
    { id: 'bank_description', label: 'Description', field: 'description', width: 200 },
    { id: 'reference',    label: 'Référence',   field: 'reference',   defaultVisible: false },
    // Relevé bancaire : sortie et entrée dans deux colonnes séparées, comme sur
    // le papier de la banque et dans l'ancien TRX_Orisha.xlsx. `amount` (signé)
    // reste la vérité en base et sert au tri, à la recherche et aux filtres.
    { id: 'debit',        label: 'Débit',       field: 'debit',       type: 'number', width: 112 },
    { id: 'credit',       label: 'Crédit',      field: 'credit',      type: 'number', width: 112 },
    { id: 'amount',       label: 'Montant',     field: 'amount',      type: 'number', width: 120, defaultVisible: false },
    { id: 'balance',      label: 'Solde',       field: 'balance',     type: 'number', width: 124 },
    { id: 'status',       label: 'Statut',      field: 'status',      type: 'single_select', width: 132, options: ['a_traiter', 'facture_recue', 'comptabilise', 'rapproche', 'ignore'] },
    // Fournisseur : le document apparié quand il existe, sinon le fournisseur
    // reconnu derrière le libellé du relevé (résolu côté serveur).
    { id: 'vendor',       label: 'Fournisseur', field: 'vendor_name', width: 180 },
    // État à la banque, rempli pour toute transaction quelle que soit la source
    // (fichier de suivi, relevé, Plaid) : autorisée, en attente, ou passée.
    { id: 'bank_state',   label: 'État',        field: 'bank_state', type: 'single_select', width: 110, options: ['complete', 'en_attente', 'autorise'] },
    { id: 'match_confidence', label: 'Confiance', field: 'match_confidence', type: 'number', defaultVisible: false },
    // Rarement rempli, et il poussait les boutons d'action hors de l'écran.
    { id: 'comment',      label: 'Commentaire', field: 'comment', defaultVisible: false },
    { id: 'reconciled_by_name', label: 'Rapproché par', field: 'reconciled_by_name', type: 'user', defaultVisible: false },
  ],

  // Fournitures (bureau, entretien, emballage) — miroir Airtable ; leurs achats
  // se voient dans la fiche.
  fournitures: [
    { id: 'name',              label: 'Fourniture',    field: 'name',              width: 420 },
    { id: 'supplier',          label: 'Fournisseur',   field: 'supplier' },
    { id: 'unit',              label: 'Unité',         field: 'unit' },
    { id: 'reference_price',   label: 'Prix de réf.',  field: 'reference_price',   type: 'number' },
    { id: 'last_purchased_at', label: 'Dernier achat', field: 'last_purchased_at', type: 'date' },
    { id: 'achats_count',      label: 'Achats',        field: 'achats_count',      type: 'number' },
    { id: 'total_spent',       label: 'Total av. tx.', field: 'total_spent',       type: 'number' },
  ],

  // Achats de fournitures (bureau, entretien, emballage) — miroir Airtable.
  achats_fournitures: [
    { id: 'purchased_at',    label: 'Date',          field: 'purchased_at',    type: 'date' },
    { id: 'fourniture_name', label: 'Fourniture',    field: 'fourniture_name', width: 420 },
    { id: 'supplier',        label: 'Fournisseur',   field: 'supplier' },
    { id: 'qty',             label: 'Quantité',      field: 'qty',             type: 'number' },
    { id: 'unit',            label: 'Unité',         field: 'unit' },
    { id: 'unit_price',      label: 'Prix unitaire', field: 'unit_price',      type: 'number' },
    { id: 'total',           label: 'Total av. tx.', field: 'total',           type: 'number' },
    { id: 'reference_price', label: 'Prix de réf.',  field: 'reference_price', type: 'number', defaultVisible: false },
  ],

  stock_movements: [
    { id: 'created_at',     label: 'Date',           field: 'created_at',     type: 'date' },
    { id: 'product_sku',    label: 'SKU',            field: 'product_sku' },
    { id: 'product_name',   label: 'Produit',        field: 'product_name'  },
    // « Type » = le champ Type d'Airtable, repris tel quel dans `reason` — mêmes
    // choix, même ordre. La colonne SQL `type` (in/out/adjustment) n'est qu'un
    // sens dérivé au sync : il se lit dans le signe de la quantité.
    { id: 'type',           label: 'Type',           field: 'reason',         type: 'single_select', options: STOCK_MOVEMENT_TYPES },
    { id: 'qty',            label: 'Quantité',       field: 'qty',            type: 'number' },
    { id: 'unit_cost',      label: 'Coût unitaire',  field: 'unit_cost',      type: 'number' },
    { id: 'movement_value', label: 'Valeur',         field: 'movement_value', type: 'number' },
    { id: 'user_name',      label: 'Utilisateur',    field: 'user_name',      type: 'user', defaultVisible: false },
  ],

  // Vacances d'un employé, sur sa fiche (bloc « Vacances ») : table manipulable.
  // « Type » est dérivé de `paid` (1/0) par la page, qui le retraduit à l'écriture.
  employee_vacations: [
    { id: 'start_date', label: 'Du',    field: 'start_date', type: 'date' },
    { id: 'end_date',   label: 'Au',    field: 'end_date',   type: 'date' },
    { id: 'paid_type',  label: 'Type',  field: 'paid_type',  type: 'single_select', options: [{ value: 'Congé payé', color: 'green' }, { value: 'Sans solde', color: 'gray' }] },
    { id: 'notes',      label: 'Notes', field: 'notes' },
  ],

  // Historique des mouvements de stock affiché sur la fiche produit (un seul produit) :
  // pas de colonnes produit (SKU/nom) puisque la fiche concerne déjà un produit unique.
  product_movements: [
    { id: 'created_at',     label: 'Date',          field: 'created_at',     type: 'date' },
    // Même « Type » que la page des mouvements : le champ Type d'Airtable.
    { id: 'type',           label: 'Type',          field: 'reason',         type: 'single_select', options: STOCK_MOVEMENT_TYPES },
    { id: 'qty',            label: 'Qté',           field: 'qty',            type: 'number' },
    { id: 'user_name',      label: 'Utilisateur',   field: 'user_name',      type: 'user' },
    { id: 'unit_cost',      label: 'Coût unitaire', field: 'unit_cost',      type: 'number', defaultVisible: false },
    { id: 'movement_value', label: 'Valeur',        field: 'movement_value', type: 'number', defaultVisible: false },
  ],

  // Journal de synchronisation (Connectors) — entièrement read-only.
  sync_log: [
    { id: 'created_at',       label: 'Date',     field: 'created_at',       type: 'date' },
    { id: 'module',           label: 'Module',   field: 'module',           type: 'single_select', options: ['airtable', 'projets', 'pieces', 'orders', 'achats', 'billets', 'serials', 'envois', 'soumissions', 'retours', 'retour_items', 'adresses', 'bom', 'serial_changes', 'assemblages', 'factures'] },
    { id: 'trigger',          label: 'Source',   field: 'trigger',          type: 'single_select', options: ['webhook', 'manual', 'scheduled'] },
    { id: 'status',           label: 'Statut',   field: 'status',           type: 'single_select', options: ['success', 'error'] },
    { id: 'records_modified', label: 'Modifiés', field: 'records_modified', type: 'number' },
    { id: 'duration_ms',      label: 'Durée',    field: 'duration_ms',      type: 'number' },
    { id: 'error_message',    label: 'Erreur',   field: 'error_message' },
  ],

  journal_entries: [
    { id: 'txn_date',    label: 'Date',   field: 'txn_date',    type: 'date' },
    { id: 'doc_number',  label: 'N°',     field: 'doc_number' },
    { id: 'memo',        label: 'Mémo',   field: 'memo' },
    { id: 'lines_count', label: 'Lignes', field: 'lines_count', type: 'number', groupable: false },
    { id: 'total',       label: 'Total',  field: 'total',       type: 'number', groupable: false },
    { id: 'qb',          label: 'QB',     field: 'qb_url',      sortable: false, filterable: false, groupable: false },
  ],

  // Numéros de série — vue unifiée des transitions d'état observées + règles
  // définies sans observation récente (SerialAccountingRules.jsx). État précédent
  // et nouvel état sont des colonnes distinctes pour permettre de grouper/trier
  // par paire de transition. Les render() sont attachés côté page.
  serial_transitions: [
    { id: 'previous_status',    label: 'État précédent', field: 'previous_status' },
    { id: 'new_status',         label: 'Nouvel état',    field: 'new_status' },
    { id: 'count',              label: 'Occurrences',    field: 'count',              type: 'number' },
    { id: 'missing_value_count', label: 'Sans valeur',   field: 'missing_value_count', type: 'number' },
    { id: 'last_seen',          label: 'Dernière',       field: 'last_seen',          type: 'date' },
    { id: 'mapping_status',     label: 'Mapping',        field: 'mapping_status',     type: 'single_select', options: ['mapped', 'skip', 'unmapped'] },
    { id: 'action',             label: 'Action',         field: null, sortable: false, filterable: false, groupable: false },
  ],

  serial_accounting_rules: [
    { id: 'previous_status', label: 'État précédent', field: 'previous_status' },
    { id: 'new_status',      label: 'Nouvel état',    field: 'new_status' },
    { id: 'debit',           label: 'Débit',          field: 'debit_account_name' },
    { id: 'credit',          label: 'Crédit',         field: 'credit_account_name' },
    { id: 'valuation',       label: 'Valeur',         field: 'valuation_source', type: 'single_select', options: ['manufacture_value', 'product_cost', 'fixed_amount'] },
    { id: 'active',          label: 'Actif',          field: 'active_label',     type: 'single_select', options: ['Oui', 'Non'] },
    { id: 'action',          label: '',               field: null, sortable: false, filterable: false, groupable: false },
  ],

  // Mouvements bruts (une ligne par changement d'état) — les champs custom de
  // serial_state_changes se fusionnent automatiquement (CUSTOM_FIELD_TABLES).
  serial_state_changes: [
    { id: 'changed_at',      label: 'Date',           field: 'changed_at',      type: 'date' },
    { id: 'serial',          label: 'Serial',         field: 'serial' },
    { id: 'product_name',    label: 'Produit',        field: 'product_name'  },
    { id: 'company_name',    label: 'Client',         field: 'company_name'  },
    { id: 'previous_status', label: 'État précédent', field: 'previous_status' },
    { id: 'new_status',      label: 'Nouvel état',    field: 'new_status' },
  ],

  serial_missing_valuations: [
    { id: 'date',       label: 'Date',       field: 'changed_at', type: 'date' },
    { id: 'serial',     label: 'Serial',     field: 'serial' },
    { id: 'product',    label: 'Produit',    field: 'product' },
    { id: 'company',    label: 'Client',     field: 'company_name' },
    { id: 'transition', label: 'Transition', field: 'transition' },
    { id: 'value',      label: 'Valeur',     field: 'value_label', sortable: false, filterable: false, groupable: false },
  ],

  users: [
    { id: 'name',   label: 'Utilisateur', field: 'name' },
    { id: 'email',  label: 'Courriel',    field: 'email' },
    { id: 'role',   label: 'Accès',       field: 'roles',  type: 'multi_select', options: ['user', 'admin', 'rh'] },
    { id: 'active', label: 'Statut',      field: 'active', type: 'boolean' },
    // Owner HubSpot : colonne masquée tant que le connecteur HubSpot n'est pas
    // configuré (filtrée dans Admin.jsx). `hubspot_owner_name` est calculé côté
    // client à partir du mapping (override manuel ou correspondance par email).
    { id: 'hubspot_owner', label: 'Owner HubSpot', field: 'hubspot_owner_name' },
    { id: 'reset',  label: '',            field: '',       sortable: false, filterable: false, groupable: false },
  ],

  catalog: [
    { id: 'name_fr',           label: 'Nom FR',      field: 'name_fr' },
    { id: 'name_en',           label: 'Nom EN',      field: 'name_en' },
    { id: 'unit_price_cad',    label: 'Prix CAD',    field: 'unit_price_cad', type: 'number' },
    { id: 'price_usd',         label: 'Prix USD',    field: 'price_usd',      type: 'number' },
    { id: 'monthly_price_cad', label: 'Mensuel CAD', field: 'monthly_price_cad', type: 'number' },
    { id: 'monthly_price_usd', label: 'Mensuel USD', field: 'monthly_price_usd', type: 'number' },
    { id: 'active',            label: 'Actif',       field: 'active',         type: 'boolean', defaultVisible: false },
  ],

  soumissions: [
    { id: 'title',           label: 'Titre',       field: 'title' },
    { id: 'company_name',    label: 'Entreprise',  field: 'company_name'  },
    { id: 'contact_name',    label: 'Contact',     field: 'contact_name'  },
    { id: 'status',          label: 'Statut',      field: 'status', type: 'single_select', options: ['Brouillon', 'Envoyée', 'Acceptée', 'Refusée', 'Expirée'] },
    { id: 'language',        label: 'Langue',      field: 'language', type: 'single_select', options: ['French', 'English'], defaultVisible: false },
    { id: 'currency',        label: 'Devise',      field: 'currency', type: 'single_select', options: ['CAD', 'USD'], defaultVisible: false },
    { id: 'created_at',      label: 'Créée le',    field: 'created_at', type: 'date' },
    { id: 'expiration_date', label: 'Expiration',  field: 'expiration_date', type: 'date' },
    { id: 'pdf',             label: 'PDF',         field: 'generated_pdf_path', sortable: false, filterable: false, groupable: false },
  ],

  // Soumissions liées affichées sur la fiche projet (read-only, scope = un projet).
  // Clé de table distincte de `soumissions` pour que les vues/colonnes persistées
  // ne se mélangent pas avec la page principale (cf. product_movements vs stock_movements).
  project_soumissions: [
    { id: 'at_id',              label: 'ID',          field: 'at_id' },
    { id: 'status',             label: 'Statut',      field: 'status', type: 'single_select', options: ['Brouillon', 'Envoyée', 'Acceptée', 'Refusée', 'Expirée', 'legacy'] },
    { id: 'created_at',         label: 'Date',        field: 'created_at', type: 'date' },
    { id: 'expiration_date',    label: 'Expiration',  field: 'expiration_date', type: 'date' },
    { id: 'purchase_price',     label: 'Prix achat',  field: 'purchase_price', type: 'number' },
    { id: 'subscription_price', label: 'Prix abo',    field: 'subscription_price', type: 'number' },
    { id: 'currency',           label: 'Devise',      field: 'currency', type: 'single_select', options: ['CAD', 'USD'] },
    { id: 'links',              label: 'Liens',       field: 'generated_pdf_path', sortable: false, filterable: false, groupable: false },
  ],

  // Factures liées affichées sur la fiche projet (read-only, scope = un projet).
  // Clé distincte de `factures` pour ne pas partager la config de vues.
  project_factures: [
    { id: 'document_number', label: 'Numéro',   field: 'document_number' },
    { id: 'status',          label: 'Statut',   field: 'status', type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',   label: 'Date',     field: 'document_date', type: 'date' },
    { id: 'due_date',        label: 'Échéance', field: 'due_date', type: 'date' },
    { id: 'total_amount',    label: 'Total',    field: 'total_amount', type: 'number' },
    { id: 'balance_due',     label: 'Solde dû', field: 'balance_due', type: 'number' },
  ],

  // Commissions liées au projet. Lues en direct dans Airtable (table hors
  // miroir) : lecture seule, pas de création ni d'édition depuis la fiche.
  project_commissions: [
    { id: 'at_id',             label: 'ID',           field: 'at_id' },
    { id: 'beneficiary_label', label: 'Bénéficiaire', field: 'beneficiary_label' },
    { id: 'rate',              label: 'Taux',         field: 'rate', type: 'number' },
    { id: 'amount',            label: 'Montant',      field: 'amount', type: 'number' },
    { id: 'paid_invoices',     label: 'Factures payées', field: 'paid_invoices', type: 'number' },
    { id: 'close_date',        label: 'Fermeture',    field: 'close_date', type: 'date' },
  ],

  // ── Sous-tableaux de la fiche entreprise (CompanyDetail) ──────────────────
  // Clés distinctes des tables principales (contacts, orders, …) pour ne pas
  // partager la config de vues persistée (cf. company_serials, project_factures).
  // La colonne `company_name` est omise partout : la fiche concerne déjà une
  // entreprise unique.
  company_contacts: [
    { id: 'name',     label: 'Nom',        field: 'last_name' },
    { id: 'email',    label: 'Courriel',   field: 'email' },
    { id: 'phone',    label: 'Téléphone',  field: 'phone', type: 'phone' },
    { id: 'language', label: 'Langue',     field: 'language', type: 'single_select', options: ['French', 'English'] },
  ],

  // Projets d'une entreprise. Colonnes tirées de `projects` ci-dessus (même
  // table, mêmes champs — cf. VIEW_KEY_TO_FIELD_KEY), sans « Entreprise » : la
  // fiche est déjà celle de l'entreprise. « Valeur (CAD) » n'y figure pas, le
  // champ a été supprimé du registre le 2026-09-03 (le portier des champs
  // supprimés le retirerait de toute façon).
  company_projects: [
    { id: 'name',           label: 'Projet',      field: 'name' },
    { id: 'type',           label: 'Type',        field: 'type', type: 'single_select', options: ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange'] },
    { id: 'probability',    label: 'Probabilité', field: 'probability', type: 'number' },
    { id: 'nb_greenhouses', label: 'Nb serres',   field: 'nb_greenhouses', type: 'number' },
    { id: 'vendeur_label',  label: 'Vendeur',     field: 'vendeur_label', mappingColumn: 'vendeur_ref', defaultVisible: false },
    { id: 'close_date',     label: 'Fermeture',   field: 'close_date', type: 'date' },
  ],

  company_orders: [
    { id: 'order_number', label: '# Commande', field: 'order_number'  },
    { id: 'status',       label: 'Statut',     field: 'status', type: 'single_select', options: ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'Drop ship seulement', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'] },
    { id: 'items_count',  label: 'Articles',   field: 'items_count', type: 'number', groupable: false, sortable: false },
    { id: 'created_at',   label: 'Date',       field: 'created_at', type: 'date' },
  ],

  // Billets d'une fiche entreprise. `tickets.company_id` étant droppée
  // (migration 040), le rattachement passe par le champ lien « Entreprise »
  // (côté serveur : GET /companies/:id/tickets). Les colonnes sont des champs
  // personnalisés des billets : le portier des champs retire celle dont le
  // champ serait supprimé, et le libellé suit celui du champ.
  company_tickets: [
    { id: 'cf_billet', label: 'Billet', field: 'cf_billet' },
    { id: 'titre',     label: 'Titre',  field: 'titre' },
    { id: 'cf_statut', label: 'Statut', field: 'cf_statut', type: 'single_select' },
    { id: 'cf_date',   label: 'Date',   field: 'cf_date', type: 'date' },
  ],

  company_discovery_forms: [
    { id: 'form_number',     label: '#',          field: 'sys_number' },
    { id: 'status',          label: 'Statut',     field: 'status', type: 'single_select', options: ['in_progress', 'submitted'] },
    { id: 'num_greenhouses', label: 'Nb serres',  field: 'num_greenhouses', type: 'number' },
    { id: 'submitted_at',    label: 'Soumis le',  field: 'submitted_at', type: 'date' },
    { id: 'created_at',      label: 'Créé le',    field: 'created_at', type: 'date' },
  ],

  company_factures: [
    { id: 'document_number',       label: 'N° document', field: 'document_number' },
    { id: 'status',                label: 'Statut',      field: 'status', type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',         label: 'Date',        field: 'document_date', type: 'date' },
    { id: 'amount_before_tax_cad', label: 'Total HT',    field: 'amount_before_tax_cad', type: 'number' },
    { id: 'currency',              label: 'Devise',      field: 'currency', type: 'single_select', options: ['CAD', 'USD', 'EUR'] },
    { id: 'stripe',                label: 'Stripe',      field: 'invoice_id', sortable: false, filterable: false, groupable: false },
  ],

  company_abonnements: [
    { id: 'product_name', label: 'Produit', field: 'product_name'  },
    { id: 'type',         label: 'Type',    field: 'type' },
    { id: 'status',       label: 'Statut',  field: 'status', type: 'single_select', options: ['active', 'trialing', 'past_due', 'canceled', 'Actif', 'Inactif', 'Suspendu', 'Annulé', 'Expiré'] },
    { id: 'amount_cad',   label: 'Montant', field: 'amount_cad', type: 'number' },
    { id: 'start_date',   label: 'Début',   field: 'start_date', type: 'date' },
    { id: 'end_date',     label: 'Fin',     field: 'end_date', type: 'date', defaultVisible: false },
  ],

  company_envois: [
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'order_number',    label: 'Commande',     field: 'order_number'  },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at', type: 'date' },
  ],

  company_tasks: [
    { id: 'title',    label: 'Tâche',    field: 'title' },
    { id: 'status',   label: 'Statut',   field: 'status', type: 'single_select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'] },
    { id: 'priority', label: 'Priorité', field: 'priority', type: 'single_select', options: ['Basse', 'Normal', 'Haute', 'Urgente'] },
    { id: 'due_date', label: 'Échéance', field: 'due_date', type: 'date' },
  ],

  company_achats: [
    { id: 'type',            label: 'Type',       field: 'type', type: 'single_select', options: ['bill', 'purchase'] },
    { id: 'reference',       label: 'Référence',  field: 'reference' },
    { id: 'status',          label: 'Statut',     field: 'status', type: 'single_select', options: ['Brouillon', 'Soumis', 'Approuvé', 'Refusé', 'Remboursé', 'Reçue', 'Approuvée', 'Payée partiellement', 'Payée', 'En retard', 'Annulée'] },
    { id: 'date_achat',      label: 'Date',       field: 'date_achat', type: 'date' },
    { id: 'due_date',        label: 'Échéance',   field: 'due_date', type: 'date', defaultVisible: false },
    { id: 'total_cad',       label: 'Total',      field: 'total_cad', type: 'number' },
    { id: 'balance_due_cad', label: 'Solde dû',   field: 'balance_due_cad', type: 'number' },
  ],

  company_retours: [
    // « N° RMA » et « Contact » retirés : colonnes droppées côté serveur
    // (migration 037), « Statut » par la 041.
    { id: 'order_number',      label: 'Commande',    field: 'order_number'  },
    { id: 'items_count',       label: 'Articles',    field: 'items_count', type: 'number' },
    { id: 'created_at',        label: 'Date',        field: 'created_at', type: 'date' },
  ],

  // Tâches affichées sur la fiche contact (ContactDetail). Clé distincte de
  // `tasks` et `company_tasks` pour une config de vues indépendante.
  contact_tasks: [
    { id: 'title',    label: 'Tâche',    field: 'title' },
    { id: 'status',   label: 'Statut',   field: 'status', type: 'single_select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'] },
    { id: 'due_date', label: 'Échéance', field: 'due_date', type: 'date' },
  ],

  automations: [
    { id: 'name',            label: 'Nom',         field: 'name' },
    { id: 'trigger_type',    label: 'Trigger',     field: 'trigger_type', type: 'single_select', options: ['record_created', 'record_updated', 'field_changed', 'field_rule', 'schedule', 'manual', 'system'] },
    { id: 'summary',         label: 'Déclencheur', field: 'summary', sortable: false },
    { id: 'active',          label: 'Statut',      field: 'active', type: 'boolean' },
    { id: 'last_run_at',     label: 'Dernier run', field: 'last_run_at', type: 'date' },
    { id: 'runs_30d',        label: 'Runs (30j)',  field: 'runs_30d', type: 'number' },
    { id: 'health',          label: 'Santé',       field: 'errors_30d', type: 'number', sortable: true },
    { id: 'system',          label: 'Système',     field: 'system', type: 'boolean', defaultVisible: false },
    { id: 'description',     label: 'Description', field: 'description', defaultVisible: false },
  ],

  stripe_invoice_items: [
    { id: 'description',              label: 'Description',     field: 'description' },
    { id: 'quantity',                 label: 'Qté',             field: 'quantity', type: 'number' },
    { id: 'unit_amount',              label: 'Prix unitaire',   field: 'unit_amount', type: 'number' },
    { id: 'amount',                   label: 'Total',           field: 'amount', type: 'number' },
    { id: 'currency',                 label: 'Devise',          field: 'currency', type: 'single_select', options: ['CAD', 'USD'] },
    { id: 'product_id',               label: 'Produit ERP',     field: 'product_id' },
    { id: 'facture_document_number',  label: 'Facture',         field: 'facture_document_number' },
    { id: 'stripe_price_id',          label: 'Stripe price',    field: 'stripe_price_id', defaultVisible: false },
    { id: 'stripe_product_id',        label: 'Stripe product',  field: 'stripe_product_id', defaultVisible: false },
    { id: 'stripe_invoice_id',        label: 'Stripe invoice',  field: 'stripe_invoice_id', defaultVisible: false },
    { id: 'period_start',             label: 'Période début',   field: 'period_start', type: 'date', defaultVisible: false },
    { id: 'period_end',               label: 'Période fin',     field: 'period_end', type: 'date', defaultVisible: false },
    { id: 'proration',                label: 'Prorata',         field: 'proration', type: 'boolean', defaultVisible: false },
    { id: 'created_at',               label: 'Créé le',         field: 'created_at', type: 'date', defaultVisible: false },
  ],

  marketing_forms: [
    { id: 'name',               label: 'Nom',                 field: 'name', width: 380 },
    { id: 'language',           label: 'Langue',              field: 'language', type: 'single_select', options: ['fr', 'en'] },
    { id: 'field_count',        label: 'Champs',              field: 'field_count', type: 'number' },
    { id: 'submission_count',   label: 'Soumissions',         field: 'submission_count', type: 'number' },
    { id: 'last_submission_at', label: 'Dernière soumission', field: 'last_submission_at', type: 'date' },
    { id: 'hs_updated_at',      label: 'Modifié',             field: 'hs_updated_at', type: 'date', defaultVisible: false },
    { id: 'hs_created_at',      label: 'Créé',                field: 'hs_created_at', type: 'date', defaultVisible: false },
  ],

  marketing_form_submissions: [
    { id: 'submitted_at', label: 'Date',       field: 'submitted_at', type: 'date' },
    { id: 'name',         label: 'Nom',        field: 'last_name', width: 180 },
    { id: 'email',        label: 'Courriel',   field: 'email', width: 260 },
    { id: 'company',      label: 'Entreprise', field: 'company', width: 180 },
    { id: 'page_url',     label: 'Page',       field: 'page_url', defaultVisible: false },
  ],

  marketing_form_script_runs: [
    { id: 'ran_at',      label: 'Date',     field: 'ran_at', type: 'date' },
    { id: 'email',       label: 'Courriel', field: 'email', width: 260 },
    { id: 'status_code', label: 'Code',     field: 'status_code', type: 'number', width: 90 },
    { id: 'error',       label: 'Erreur',   field: 'error', width: 280 },
    { id: 'output',      label: 'Journal',  field: 'output', width: 320, defaultVisible: false },
    { id: 'duration_ms', label: 'Durée',    field: 'duration_ms', type: 'number', defaultVisible: false },
    { id: 'retry',       label: '',         field: 'id', width: 50, sortable: false },
  ],

  stripe_payouts: [
    { id: 'arrival_date',  label: 'Date de dépôt',  field: 'arrival_date', type: 'date' },
    { id: 'stripe_id',     label: 'Stripe ID',      field: 'stripe_id',    defaultVisible: false },
    { id: 'amount',        label: 'Montant',        field: 'amount',       type: 'number' },
    { id: 'currency',      label: 'Devise',         field: 'currency',     type: 'single_select', options: ['CAD', 'USD'] },
    { id: 'status',        label: 'Statut',         field: 'status',       type: 'single_select', options: ['paid', 'pending', 'in_transit', 'canceled', 'failed'] },
    { id: 'method',        label: 'Méthode',        field: 'method',       type: 'single_select', options: ['standard', 'instant'], defaultVisible: false },
    { id: 'type',          label: 'Type',           field: 'type',         defaultVisible: false },
    { id: 'bank',          label: 'Banque',         field: 'bank_name' },
    { id: 'qb_deposit_id', label: 'QB Deposit',     field: 'qb_deposit_id' },
    { id: 'qb_pushed_at',  label: 'Envoyé à QB',    field: 'qb_pushed_at', type: 'date', defaultVisible: false },
    { id: 'description',   label: 'Description',    field: 'description',  defaultVisible: false },
    { id: 'created_date',  label: 'Créé le',        field: 'created_date', type: 'date', defaultVisible: false },
  ],

  qualification_calls: [
    { id: 'call_date',         label: 'Date',          field: 'call_date',         type: 'date' },
    { id: 'company_name',      label: 'Entreprise',    field: 'company_name'  },
    { id: 'assignee',          label: 'Vendeur',       field: 'assignee' },
    { id: 'status',            label: 'Statut',        field: 'status',            type: 'single_select', options: ['En cours', 'Terminé', 'Abandonné'] },
    { id: 'contact_full_name', label: 'Contact',       field: 'contact_full_name', defaultVisible: false },
    { id: 'motivation_today',  label: 'Motivation',    field: 'motivation_today' },
    { id: 'pain_points_count', label: 'Pains',         field: 'pain_points_count', type: 'number' },
    { id: 'red_flags_count',   label: 'Red flags',     field: 'red_flags_count',   type: 'number' },
    { id: 'quote_paid_at',     label: 'Payé',          field: 'quote_paid_at',     type: 'date' },
    { id: 'source',            label: 'Source',        field: 'source',            type: 'single_select', options: ['ERP', 'Airtable'] },
    { id: 'summary',           label: 'Résumé',        field: 'summary',           defaultVisible: false },
    { id: 'next_steps',        label: 'Suite',         field: 'next_steps',        defaultVisible: false },
    { id: 'heard_about',       label: 'Source du lead', field: 'heard_about',      defaultVisible: false },
    { id: 'created_at',        label: 'Créé le',       field: 'created_at',        type: 'date', defaultVisible: false },
  ],

  discovery_forms: [
    { id: 'form_number',          label: '#',                field: 'sys_number' },
    { id: 'company_name',         label: 'Entreprise',       field: 'company_name'  },
    { id: 'status',               label: 'Statut',           field: 'status', type: 'single_select', options: ['in_progress', 'submitted'] },
    { id: 'num_greenhouses',      label: 'Nb serres',        field: 'num_greenhouses', type: 'number' },
    { id: 'chief_grower_count',   label: 'Chef de culture',  field: 'chief_grower_count', type: 'number' },
    { id: 'helper_count',         label: 'Helper',           field: 'helper_count', type: 'number' },
    { id: 'submitted_at',         label: 'Soumis le',        field: 'submitted_at', type: 'date' },
    { id: 'created_at',           label: 'Créé le',          field: 'created_at', type: 'date' },
    // L'URL complète, pas le jeton : retypée « URL », la colonne doit rester cliquable.
    { id: 'public_link',          label: 'Lien public',      field: 'public_url', sortable: false, filterable: false, groupable: false },
  ],

  public_files: [
    { id: 'original_name',    label: 'Nom du fichier',  field: 'original_name' },
    { id: 'attachment',       label: 'Attachement',     field: 'token', type: 'attachment', width: 120, sortable: false, filterable: false, groupable: false, description: 'Aperçu du fichier. Cliquez sur la miniature pour l’agrandir.' },
    { id: 'folder',           label: 'Dossier',         field: 'folder' },
    { id: 'description',      label: 'Description',     field: 'description' },
    { id: 'tags',             label: 'Étiquettes',      field: 'tags', sortable: false },
    { id: 'mime_type',        label: 'Type',            field: 'mime_type', defaultVisible: false },
    { id: 'size',             label: 'Taille',          field: 'size', type: 'number' },
    { id: 'uploaded_by_name', label: 'Téléversé par',   field: 'uploaded_by_name', description: "Utilisateur connecté au moment du téléversement." },
    { id: 'created_at',       label: 'Téléversé le',    field: 'created_at', type: 'date' },
    { id: 'link',             label: 'Lien public',     field: 'token', sortable: false, filterable: false, groupable: false },
  ],

  sale_receipts: [
    { id: 'company',         label: 'Fournisseur',    field: 'company' },
    { id: 'receipt_date',    label: 'Date',           field: 'receipt_date', type: 'date' },
    { id: 'receipt_number',  label: 'N° de reçu',     field: 'receipt_number' },
    { id: 'total',           label: 'Total',          field: 'total', type: 'number' },
    { id: 'currency',        label: 'Devise',         field: 'currency', type: 'single_select', options: ['CAD', 'USD', 'EUR'], defaultVisible: false },
    { id: 'payment_method',  label: 'Mode paiement',  field: 'payment_method', defaultVisible: false },
    { id: 'status',          label: 'Statut',         field: 'status', type: 'single_select', options: ['pending', 'processing', 'done', 'error'] },
    { id: 'quickbooks_id',   label: 'QuickBooks',     field: 'quickbooks_id' },
    { id: 'original_name',   label: 'Fichier',        field: 'original_name', defaultVisible: false },
    // Le fichier récupéré lui-même, rendu comme un attachement (pastille/vignette
    // cliquable, une par page). Dérivé de `pages` — aucune colonne SQL.
    { id: 'justificatif',    label: 'Pièce justificative', field: 'justificatif', type: 'attachment', width: 170, sortable: false, filterable: false, groupable: false, description: 'Le document récupéré (courriel, portail, téléversement). Clic = ouvrir le fichier.' },
    { id: 'created_at',      label: 'Téléversé le',   field: 'created_at', type: 'date', defaultVisible: false },
    { id: 'archived_at',     label: 'Archivé le',     field: 'archived_at', type: 'date', defaultVisible: false },
    { id: 'read_at',         label: 'Lu le',          field: 'read_at', type: 'date', defaultVisible: false },
  ],
}
