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
  company_orders: 'Commandes (entreprise)',
  company_tickets: 'Support (entreprise)',
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
  hour_bank:      "Banque d'heures",
  paies:          'Paies',
  paie_items:     'Items de paie',
  stock_movements: "Mouvements d'inventaire",
  product_movements: "Mouvements de stock (produit)",
  product_achats: 'Achats (pièce)',
  sync_log: 'Journal de synchronisation',
  journal_entries: 'Écritures de journal',
  stripe_payouts: 'Stripe Payouts',
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
  payments: 'Paiements',
  bank_transactions: 'Rapprochement bancaire',
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
}

export const LINKED_RECORD_TYPE_LABELS = {
  company_name: 'Lien vers Entreprise',
  contact_name: 'Lien vers Contact',
  product_name: 'Lien vers Produit',
  order_number: 'Lien vers Commande',
  ticket_title: 'Lien vers Billet',
  project_name: 'Lien vers Projet',
}

export const TABLE_COLUMN_META = {
  // Feed des opérations — journal d'activité (qui / quoi / quand). Lecture seule.
  // Les options single_select reflètent les valeurs brutes émises par
  // emitEntity/emitOrder/emitCompany (server/src/services/realtimeEmitters.js) ;
  // l'affichage FR est géré par les render() de ActivityFeed.jsx.
  activity_log: [
    { id: 'created_at',  label: 'Quand',        field: 'created_at',  type: 'date' },
    { id: 'user_name',   label: 'Qui',          field: 'user_name',   type: 'user' },
    { id: 'action',      label: 'Action',       field: 'action',      type: 'single_select', options: ['created', 'updated', 'deleted'] },
    { id: 'entity_type', label: 'Type',         field: 'entity_type', type: 'single_select', options: ['order', 'company', 'contact', 'product', 'ticket', 'task', 'project', 'interaction', 'soumission', 'call', 'purchase', 'facture', 'sale_receipt', 'timesheet', 'employee', 'paie', 'hour_bank_entry', 'activity_code', 'shipment', 'adresse', 'vacation', 'achat_fournisseur'] },
    { id: 'detail',      label: 'Enregistrement', field: 'detail' },
  ],

  // Journal des nouveautés (/changelog) — lignes construites à partir de
  // client/src/data/changelog.json, une par entrée. `type` = nature dominante
  // de l'entrée (nouveauté > amélioration > correction) ; le détail complet des
  // changements s'ouvre en dépliant la ligne. `requester` vient du champ
  // `requester` de l'entrée, sinon du rapprochement serveur avec la demande
  // d'origine (GET /api/changelog/requesters).
  changelog: [
    { id: 'date',      label: 'Date',       field: 'date',      type: 'date' },
    { id: 'title',     label: 'Nouveauté',  field: 'title' },
    { id: 'category',  label: 'Domaine',    field: 'category',  type: 'single_select' },
    { id: 'type',      label: 'Nature',     field: 'type',      type: 'single_select', options: ['Nouveauté', 'Amélioration', 'Correction'], description: 'Nature dominante de l’entrée : nouveauté, puis amélioration, puis correction.' },
    { id: 'requester', label: 'Demandé par', field: 'requester', type: 'user', description: 'Qui a demandé le changement. Déduit de la demande traitée le même jour quand l’entrée ne le précise pas.' },
    { id: 'summary',   label: 'Détail',     field: 'summary' },
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

  tasks: [
    { id: 'title',         label: 'Titre',        field: 'title' },
    { id: 'type',          label: 'Type',         field: 'type',          type: 'single_select', options: ['Problème'] },
    { id: 'status',        label: 'Statut',       field: 'status',        type: 'single_select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'] },
    { id: 'priority',      label: 'Priorité',     field: 'priority',      type: 'single_select', options: ['Basse', 'Normal', 'Haute', 'Urgente'] },
    { id: 'due_date',      label: 'Échéance',     field: 'due_date',      type: 'date' },
    { id: 'company_name',  label: 'Entreprise',   field: 'company_name',  defaultVisible: true  },
    { id: 'contact_name',  label: 'Contact',      field: 'contact_name',  defaultVisible: true  },
    { id: 'ticket_title',  label: 'Billet',       field: 'ticket_title',  defaultVisible: false  },
    { id: 'assigned_name', label: 'Responsable',  field: 'assigned_name', type: 'user', defaultVisible: false },
    { id: 'created_at',    label: 'Créée le',     field: 'created_at',    type: 'date', defaultVisible: false },
  ],

  companies: [
    // « Contacts » (contacts_count) retirée le 2026-09-03 : champ supprimé.
    { id: 'name',            label: 'Entreprise',   field: 'name' },
    { id: 'city',            label: 'Ville',        field: 'city' },
    { id: 'type',            label: 'Type',         field: 'type',            type: 'single_select', options: ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre'] },
    { id: 'phone',           label: 'Téléphone',    field: 'phone', type: 'phone' },
    { id: 'lifecycle_phase', label: 'Phase',        field: 'lifecycle_phase', type: 'single_select', options: ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore'] },
  ],

  contacts: [
    // « Adresse de livraison » (has_shipping_address) retirée le 2026-09-03 :
    // champ supprimé. La colonne SQL et son calcul serveur restent.
    { id: 'full_name',    label: 'Nom',         field: 'first_name' },
    { id: 'company_name', label: 'Entreprise',  field: 'company_name'  },
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
    { id: 'name',           label: 'Projet',            field: 'name' },
    { id: 'company_name',   label: 'Entreprise',        field: 'company_name'  },
    { id: 'type',           label: 'Type',              field: 'type',        type: 'single_select', options: ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange'] },
    // Le champ « Statut » a été retiré (signalement depuis /champs/projects) :
    // la colonne SQL `projects.status` et les routes qui la lisent restent en
    // place, mais elle ne s'affiche plus nulle part dans l'interface.
    { id: 'probability',    label: 'Probabilité',       field: 'probability', type: 'number', defaultVisible: false, description: 'Probabilité de conclusion du projet, en pourcentage (0 à 100).' },
    { id: 'nb_greenhouses', label: 'Nb serres',         field: 'nb_greenhouses', type: 'number', defaultVisible: false, description: 'Nombre de serres couvertes par ce projet.' },
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

  // Champs natifs de la table products. Les 139 champs Airtable dynamiques
  // arrivent en plus via /api/views/products (custom_fields kind='data') —
  // depuis la fusion airtable_field_defs → custom_fields, les défs `native_*`
  // ne migrent plus côté serveur, donc les natifs doivent vivre ici comme pour
  // les autres tables. Labels alignés sur ensureNativeFieldDefs (index.js).
  products: [
    // Rendu vignette : render() custom dans Products.jsx (pattern Purchases).
    { id: 'image_url', label: 'Image',                  field: 'image_url', sortable: false, filterable: false, groupable: false },
    { id: 'name_fr',   label: 'Nom',                    field: 'name_fr' },
    { id: 'name_en',   label: 'Nom (EN)',               field: 'name_en',   defaultVisible: false },
    { id: 'sku',       label: 'SKU',                    field: 'sku' },
    { id: 'type',      label: 'Type',                   field: 'type' },
    { id: 'unit_cost', label: 'Coût unitaire',          field: 'unit_cost', type: 'number', defaultVisible: false },
    { id: 'price_cad', label: 'Prix (CAD)',             field: 'price_cad', type: 'number', defaultVisible: false },
    { id: 'stock_qty', label: 'Quantité en inventaire', field: 'stock_qty', type: 'number' },
    { id: 'min_stock', label: 'Stock minimum',          field: 'min_stock', type: 'number', defaultVisible: false },
    // « Qté à cmd » (≠ « Quantité à commander ») : le champ Airtable
    // quantite_a_commander porte déjà ce label — une collision de label le
    // ferait disparaître du merge de useTableView (les pills y réfèrent).
    { id: 'order_qty', label: 'Qté à cmd',              field: 'order_qty', type: 'number', defaultVisible: false },
    { id: 'supplier',  label: 'Fournisseur',            field: 'supplier',  defaultVisible: false },
    { id: 'is_sellable', label: 'Vendable',             field: 'is_sellable', type: 'boolean', defaultVisible: false },
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
    { id: 'items_count',    label: 'Items',             field: 'items_count', type: 'number', groupable: false, sortable: false, description: 'Nombre de lignes d\'articles (line items) sur la commande.' },
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
    { id: 'product_id', label: 'Produit', field: 'product_id', sortable: false, filterable: false, groupable: false, description: 'Produit lié à la ligne — affiché par son nom, cliquable vers sa fiche.' },
    { id: 'qty',                label: 'Qté',             field: 'qty', type: 'number' },
    { id: 'item_type',          label: 'Type',            field: 'item_type', type: 'single_select', options: ['Facturable', 'Remplacement', 'Non facturable'] },
    { id: 'fulfillment_status', label: 'Prélèvement',     field: 'fulfillment_status', type: 'single_select', options: ['À prélever', 'Prélevé', "Dans l'envoi", 'Envoyé', 'En attente'] },
    // « Série remplacée » (colonne replaced_serial) retirée le 2026-09-03 :
    // redondante avec le champ Airtable « # de série remplacé » (de_serie_remplace),
    // seul conservé. La colonne SQL et son écriture serveur (retours) restent.
    // « Coût unitaire » retirée le 2026-09-03 : le coût d'une ligne se lit dans
    // « Coût total au moment de l'envoi », gelé à l'expédition. La colonne SQL
    // unit_cost reste alimentée par Airtable et sert de base à ce gel pour les
    // pièces sans numéro de série — elle n'est simplement plus affichée.
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
    { id: 'items_summary',   label: 'Articles',     field: 'items_summary', sortable: false, groupable: false, description: "Articles de la commande rattachés à cet envoi." },
    { id: 'serials_summary', label: 'N° de série',  field: 'serials_summary', sortable: false, groupable: false, description: 'Numéros de série des articles de cet envoi.' },
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

  tickets: [
    { id: 'title',         label: 'Titre',      field: 'title' },
    { id: 'contact_name',  label: 'Contact',    field: 'contact_name'  },
    { id: 'company_name',  label: 'Entreprise', field: 'company_name'  },
    { id: 'status',        label: 'Statut',     field: 'status', type: 'single_select', options: ['open', 'in_progress', 'resolved', 'closed'] },
    { id: 'type',          label: 'Type',       field: 'type',   type: 'single_select', options: ['question', 'bug', 'feature', 'installation', 'maintenance', 'autre'] },
    { id: 'assigned_name', label: 'Assigné à',  field: 'assigned_name', type: 'user' },
    { id: 'duration_minutes', label: 'Durée (min)', field: 'duration_minutes', type: 'number', defaultVisible: false, description: 'Temps total passé sur le billet, en minutes.' },
    { id: 'survey_rating', label: 'Satisfaction', field: 'survey_rating', type: 'number', defaultVisible: false, description: 'Note du sondage de satisfaction envoyé par SMS (1 à 5). Vide = sondage non envoyé ou sans réponse.' },
    { id: 'created_at', label: 'Créé le', field: 'created_at', type: 'date' },
  ],

  purchases: [
    { id: 'image',         label: 'Image',       field: 'product_image', sortable: false, filterable: false, groupable: false, defaultVisible: false },
    { id: 'product_name',  label: 'Produit',     field: 'product_name'  },
    { id: 'sku',           label: 'SKU',         field: 'sku' },
    { id: 'supplier',      label: 'Fournisseur', field: 'supplier' },
    { id: 'status',        label: 'Statut',      field: 'status', type: 'single_select', options: ['pending', 'ordered', 'partial', 'received', 'cancelled'] },
    { id: 'qty_ordered',   label: 'Qté commandée', field: 'qty_ordered', type: 'number' },
    { id: 'qty_received',  label: 'Qté reçue',   field: 'qty_received', type: 'number' },
    { id: 'order_date',    label: "Date commande", field: 'order_date', type: 'date' },
    // « Date prévue » supprimée (colonne droppée, migration 029) — jamais remplie.
    { id: 'received_date', label: 'Date de réception complète', field: 'received_date', type: 'date', defaultVisible: false },
  ],

  // Achats d'une pièce (fiche produit) : mêmes lignes que /purchases, mais la
  // pièce est déjà le sujet de la fiche — pas de colonnes Produit/SKU/Image.
  product_achats: [
    { id: 'reference',     label: 'Référence',   field: 'reference' },
    { id: 'supplier',      label: 'Fournisseur', field: 'supplier' },
    { id: 'status',        label: 'Statut',      field: 'status', type: 'single_select', options: ['Commandé', 'Reçu partiellement', 'Reçu', 'Annulé'] },
    { id: 'qty_ordered',   label: 'Qté commandée', field: 'qty_ordered', type: 'number' },
    { id: 'qty_received',  label: 'Qté reçue',   field: 'qty_received', type: 'number' },
    { id: 'unit_cost',     label: 'Coût unitaire', field: 'unit_cost', type: 'number' },
    { id: 'order_date',    label: 'Date commande', field: 'order_date', type: 'date' },
    { id: 'received_date', label: 'Date de réception complète', field: 'received_date', type: 'date', defaultVisible: false },
  ],

  serial_numbers: [
    { id: 'serial',        label: 'Numéro de série', field: 'serial' },
    { id: 'product_name',  label: 'Produit',         field: 'product_name'  },
    { id: 'company_name',  label: 'Entreprise',      field: 'company_name'  },
    { id: 'status',        label: 'Statut',          field: 'status', type: 'single_select', options: ['active', 'inactive', 'returned', 'lost'] },
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
    { id: 'summary',      label: 'Résumé',      field: null,               sortable: false, filterable: false, groupable: false },
    { id: 'timestamp',    label: 'Date',        field: 'timestamp',        type: 'date' },
    { id: 'duration_seconds', label: 'Durée',   field: 'duration_seconds', type: 'number', defaultVisible: false },
    { id: 'user_name',    label: 'Utilisateur', field: 'user_name',        type: 'user', defaultVisible: false },
  ],

  retours: [
    // Champ personnalisé depuis la migration 026 (le natif return_number a été
    // droppé) : l'entrée reste ici pour le rendu monospace, le libellé vient
    // désormais de custom_fields (DataTable.columnsWithOwnCf).
    { id: 'n_de_retour',       label: 'N° de retour',         field: 'n_de_retour' },
    // « Entreprise » est un CHAMP PERSO lui aussi (custom_fields, kind='lookup'
    // sur company_id → companies.name, cf. nativeFieldConversions.js) : plus
    // aucune définition en dur, plus de LEFT JOIN dans les routes. La ligne
    // n'est gardée ici que pour son rendu — le nom cliquable vers la fiche
    // entreprise, qu'un lookup texte ne saurait pas produire. Libellé, type et
    // suppression viennent de /champs/retours.
    { id: 'company_name',      label: 'Entreprise',           field: 'company_name'  },
    // « Suivi » (tracking_number) et « Statut de traitement » (processing_status)
    // retirés : colonnes droppées, cf. migration serveur 028.
    { id: 'created_at',        label: 'Date',                 field: 'created_at', type: 'date' },
  ],

  // Articles d'un retour (tableau « Articles » de la fiche retour, clé de vue
  // `retour_items`). Les colonnes listées ici sont les colonnes PHYSIQUES de
  // return_items (plus les libellés joints par la route : n° de série, nom du
  // produit, SKU) ; les 46 champs Airtable de la table restent proposés par le
  // sélecteur de champs sans s'afficher d'office.
  return_items: [
    { id: 'serial_number',  label: 'N° de série',   field: 'serial_number', description: 'Numéro de série retourné — cliquable vers sa fiche.' },
    { id: 'product_name',   label: 'Produit reçu',  field: 'product_name', description: 'Produit de la ligne, à défaut celui du numéro de série — cliquable vers sa fiche.' },
    { id: 'sku',            label: 'SKU',           field: 'sku' },
    { id: 'qty',            label: 'Qté',           field: 'qty', type: 'number' },
    { id: 'return_reason',  label: 'Raison',        field: 'return_reason' },
    { id: 'action',         label: 'Action',        field: 'action' },
    { id: 'received_at',    label: 'Reçu le',       field: 'received_at', type: 'date' },
    { id: 'product_to_receive', label: 'Produit à recevoir', field: 'product_to_receive' },
    { id: 'product_to_send',    label: 'Produit à envoyer',  field: 'product_to_send' },
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
    { id: 'customer_email',        label: 'Courriel client',   field: 'customer_email',        defaultVisible: false, description: 'Courriel du client Stripe (mapping configurable via « Sync Stripe »). Utile pour les clients Stripe sans entreprise dans l\'ERP.' },
    { id: 'project_name',          label: 'Projet',            field: 'project_name',          defaultVisible: false  },
    { id: 'order_number',          label: 'Commande',          field: 'order_number',          defaultVisible: false  },
    { id: 'status',                label: 'Statut',            field: 'status',                type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',         label: 'Date document',     field: 'document_date',         type: 'date' },
    { id: 'payment_date',          label: 'Date de paiement',  field: 'payment_date',          type: 'date', defaultVisible: false, description: 'Date à laquelle la facture a été payée : encaissement Stripe (paid_at) ou, à défaut, dernier paiement manuel enregistré (chèque, virement…). Couvre les paiements Stripe qu\'un rollup sur la table Paiements ne voit pas.' },
    { id: 'payment_reference',     label: 'ID de paiement',    field: 'payment_reference',     defaultVisible: false, sortable: false, description: 'Identifiant du paiement : payment intent Stripe (pi_…) ou, à défaut, charge Stripe, encaissements manuels de la table Paiements, ou identifiant de facture Stripe (in_…). Couvre les encaissements Stripe qu\'un rollup sur la table Paiements ne voit pas (Stripe ne crée pas de ligne de paiement).' },
    { id: 'due_date',              label: 'Échéance',          field: 'due_date',              type: 'date', defaultVisible: false },
    { id: 'currency',              label: 'Devise',            field: 'currency',              type: 'single_select', options: ['CAD', 'USD', 'EUR'], defaultVisible: false },
    { id: 'amount_before_tax_cad', label: 'Avant taxes (CAD)', field: 'amount_before_tax_cad', type: 'number', description: 'Montant hors taxes converti en CAD au taux de la date de facture.' },
    { id: 'total_amount',          label: 'Total',             field: 'total_amount',          type: 'number', description: 'Total taxes incluses, dans la devise d\'origine de la facture.' },
    { id: 'balance_due',           label: 'Solde dû',          field: 'balance_due',           type: 'number', description: 'Reste à payer = total − paiements − remboursements. Zéro quand la facture est soldée.' },
    { id: 'refund_amount',         label: 'Remboursé',         field: 'refund_amount',         type: 'number', defaultVisible: false, description: 'Somme des remboursements (refunds) appliqués à cette facture.' },
    { id: 'is_sent',               label: 'Envoyée',           field: 'is_sent',               type: 'boolean', defaultVisible: false },
    { id: 'deferred_revenue_state',label: 'Revenu reçu d\'avance', field: 'deferred_revenue_state', type: 'single_select', options: ['Constaté', 'En attente', '—'], defaultVisible: false, description: 'État du revenu reporté : « En attente » tant que l\'expédition n\'a pas eu lieu, « Constaté » une fois la commande expédiée.' },
    { id: 'notes',                 label: 'Notes',             field: 'notes' },
  ],

  payments: [
    { id: 'received_at',    label: 'Date',        field: 'received_at',   type: 'date' },
    { id: 'direction',      label: 'Type',        field: 'direction',     type: 'single_select', options: ['in', 'out'] },
    { id: 'method',         label: 'Méthode',     field: 'method',        type: 'single_select', options: ['stripe', 'cheque', 'virement_bancaire', 'interac', 'comptant', 'autre'] },
    { id: 'company_name',   label: 'Entreprise',  field: 'company_name'  },
    { id: 'document_number',label: 'Facture',     field: 'document_number' },
    { id: 'amount',         label: 'Montant',     field: 'amount',        type: 'number', description: 'Montant du paiement dans sa devise d\'origine.' },
    { id: 'currency',       label: 'Devise',      field: 'currency',      type: 'single_select', options: ['CAD', 'USD', 'EUR'], defaultVisible: false },
    { id: 'amount_cad',     label: 'Montant (CAD)', field: 'amount_cad',  type: 'number', description: 'Montant converti en CAD au taux de la date du paiement. Vide pour les encaissements Stripe (convertis au payout).' },
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
    { id: 'amount_cad_delta',    label: 'Δ MRR (CAD)',    field: 'amount_cad_delta', type: 'number', description: 'Variation du revenu mensuel récurrent (MRR) en CAD : positive pour un upgrade/création, négative pour un downgrade/churn.' },
    { id: 'rachat',              label: 'Rachat',         field: 'rachat_status', type: 'single_select', options: ['probable', 'confirmed', 'merged', 'none'], sortable: false, description: 'Statut de détection d\'un rachat (churn suivi d\'une recréation rapprochée) : probable, confirmé, fusionné ou aucun.' },
    { id: 'previous_amount_cad', label: 'Avant (CAD)',    field: 'previous_amount_cad', type: 'number', defaultVisible: false },
    { id: 'new_amount_cad',      label: 'Après (CAD)',    field: 'new_amount_cad', type: 'number', defaultVisible: false },
    { id: 'currency',            label: 'Devise',         field: 'currency', type: 'single_select', options: ['CAD', 'USD'], defaultVisible: false },
  ],

  assemblages: [
    { id: 'product_name', label: 'Produit',         field: 'product_name'  },
    { id: 'sku',          label: 'SKU',             field: 'sku' },
    { id: 'qty_produced', label: 'Qté produite',    field: 'qty_produced', type: 'number' },
    { id: 'assembled_at', label: 'Date assemblage', field: 'assembled_at', type: 'date' },
  ],

  bom_items: [
    { id: 'component_image', label: 'Image',         field: 'component_image_url', sortable: false, filterable: false, groupable: false },
    { id: 'component_name',  label: 'Composant',     field: 'component_name' },
    { id: 'component_sku',   label: 'SKU composant', field: 'component_sku' },
    { id: 'qty_required',    label: 'Qté requise',   field: 'qty_required', type: 'number' },
    { id: 'component_stock_qty', label: 'Stock composant', field: 'component_stock_qty', type: 'number', description: 'Stock courant du composant en inventaire. Croisé avec « Qté requise » pour calculer le nombre d\'unités assemblables.' },
    { id: 'buildable',       label: 'Assemblables',  field: 'buildable', type: 'number', sortable: false, filterable: false, groupable: false, description: 'Unités du produit que ce composant seul permet d\'assembler = plancher(Stock composant ÷ Qté requise).' },
    { id: 'ref_des',         label: 'Ref. des.',     field: 'ref_des' },
    { id: 'product_name',    label: 'Produit parent', field: 'product_name', defaultVisible: false  },
    { id: 'product_sku',     label: 'SKU parent',     field: 'product_sku',  defaultVisible: false },
  ],

  employees: [
    { id: 'full_name',             label: 'Nom',                field: 'last_name' },
    { id: 'active',                label: 'Actif',              field: 'active', type: 'boolean' },
    { id: 'accounting_department', label: 'Département',        field: 'accounting_department', type: 'single_select', options: ['R&D', 'Opérations', 'Marketing'] },
    { id: 'matricule',             label: 'Matricule',          field: 'matricule', defaultVisible: false },
    { id: 'email_work',            label: 'Courriel travail',   field: 'email_work' },
    { id: 'email_personal',        label: 'Courriel perso',     field: 'email_personal', defaultVisible: false },
    { id: 'phone_work',            label: 'Téléphone travail',  field: 'phone_work', type: 'phone' },
    { id: 'phone_personal',        label: 'Téléphone perso',    field: 'phone_personal', type: 'phone', defaultVisible: false },
    { id: 'hire_date',             label: "Date d'embauche",    field: 'hire_date',  type: 'date' },
    { id: 'end_date',              label: "Date de fin",        field: 'end_date',   type: 'date', defaultVisible: false },
    { id: 'birth_date',            label: 'Date de naissance',  field: 'birth_date', type: 'date', defaultVisible: false },
    { id: 'gender',                label: 'Genre',              field: 'gender', type: 'single_select', options: ['Homme', 'Femme', 'Autre'], defaultVisible: false },
    { id: 'hours_per_week',        label: 'Heures/sem',         field: 'hours_per_week', type: 'number', defaultVisible: false },
    { id: 'last_raise_date',       label: 'Dernière augm.',     field: 'last_raise_date', type: 'date', defaultVisible: false },
    { id: 'is_salesperson',        label: 'Vendeur',            field: 'is_salesperson', type: 'boolean', defaultVisible: false },
    { id: 'is_consultant',         label: 'Consultant',         field: 'is_consultant',  type: 'boolean', defaultVisible: false },
    { id: 'group_insurance',       label: 'Assurance coll.',    field: 'group_insurance', type: 'boolean', defaultVisible: false },
    { id: 'office_key',            label: 'Clef bureau',        field: 'office_key', type: 'boolean', defaultVisible: false },
    { id: 'address',               label: 'Adresse',            field: 'address', defaultVisible: false },
    { id: 'address_verified',      label: 'Adresse validée',    field: 'address_verified', type: 'boolean', defaultVisible: false },
    { id: 'emergency_contact',     label: "Contact d'urgence",  field: 'emergency_contact', defaultVisible: false },
    { id: 'nethris_username',      label: 'Nethris username',   field: 'nethris_username', defaultVisible: false },
    { id: 'insurance_id',          label: 'ID Assurances',      field: 'insurance_id', defaultVisible: false },
    { id: 'banking_info',          label: 'Coord. bancaires',   field: 'banking_info', defaultVisible: false },
    { id: 'peer_reviews',          label: 'Éval. par pairs',    field: 'peer_reviews', defaultVisible: false },
    { id: 'issues',                label: 'Problèmes',          field: 'issues', defaultVisible: false },
  ],

  // Banque d'heures — soldes agrégés par employé (lignes expandables vers
  // l'historique des ajustements). Voir BanqueHeures.jsx.
  hour_bank: [
    { id: 'employee_name',   label: 'Employé',         field: 'employee_name', type: 'text' },
    { id: 'matricule',       label: 'Matricule',       field: 'matricule', type: 'text' },
    { id: 'entry_count',     label: 'Ajustements',     field: 'entry_count', type: 'number', description: 'Nombre d\'ajustements enregistrés dans la banque d\'heures de l\'employé.' },
    { id: 'balance_hours',   label: 'Solde (h)',       field: 'balance_hours', type: 'number', description: 'Solde courant en heures = somme algébrique de tous les ajustements de l\'employé.' },
    { id: 'vacation_remaining', label: 'Solde vac. (j)', field: 'vacation_remaining', type: 'number', description: 'Jours de vacances payées restants pour l\'année civile courante = droit annuel − jours ouvrables pris. Négatif = dépassement.' },
    { id: 'last_entry_date', label: 'Dernier ajust.',  field: 'last_entry_date', type: 'date', description: 'Date du dernier ajustement appliqué à la banque d\'heures.' },
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
    { id: 'holiday_1_20',   label: 'Férié 1/20',     field: 'holiday_1_20', type: 'number', description: 'Paie fériée Québec : 1/20 des heures régulières des 2 dernières paies × taux horaire × nombre de congés fériés. Calculé à la création de la paie.' },
    { id: 'insurance_gains', label: 'Gains assur.',  field: 'insurance_gains', type: 'number', description: 'Gains assurables — synchronisés depuis Airtable.' },
    { id: 'paid_leave',     label: 'Congés payés',   field: 'paid_leave', description: 'Congés payés — synchronisés depuis Airtable.' },
    { id: 'rsde_pct',       label: 'RSDE %',         field: 'rsde_pct', type: 'number', defaultVisible: false, description: 'Pourcentage RSDE (recherche scientifique) — synchronisé depuis Airtable.' },
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
    { id: 'actions',        label: 'Action',         field: 'actions',    sortable: false, filterable: false, groupable: false, alwaysVisible: true, description: 'Bouton « Se désabonner » / « Réactiver » — ouvre la page d\'annulation du fournisseur.' },
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
    { id: 'product_id',       label: 'Produit',         field: 'product_id', sortable: false, filterable: false, groupable: false, description: 'Produit lié à la ligne — affiché par son nom, cliquable vers sa fiche.' },
    { id: 'sku',              label: 'SKU',             field: 'sku' },
    { id: 'qty',              label: 'Qté',             field: 'qty', type: 'number' },
    // Pas de « Coût unitaire » ici non plus : ces lignes SONT des order_items
    // (voir VIEW_KEY_TO_SQL_TABLE) et le champ a été retiré le 2026-09-03.
    { id: 'line_weight_lbs',  label: 'Poids (lbs)',     field: 'line_weight_lbs', type: 'number', description: 'Poids de la ligne = poids unitaire du produit × quantité.' },
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
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at',  type: 'date' },
  ],

  bank_transactions: [
    { id: 'txn_date',     label: 'Date',        field: 'txn_date',    type: 'date', width: 104 },
    { id: 'description',  label: 'Libellé',     field: 'label',       description: "« Autres détails » du relevé (la nature réelle : bénéficiaire, fournisseur…), avec la description de la banque en dessous. Les relevés sans « Autres détails » affichent la description." },
    { id: 'bank_description', label: 'Description banque', field: 'description', defaultVisible: false },
    { id: 'reference',    label: 'Référence',   field: 'reference',   defaultVisible: false },
    // Relevé bancaire : sortie et entrée dans deux colonnes séparées, comme sur
    // le papier de la banque et dans l'ancien TRX_Orisha.xlsx. `amount` (signé)
    // reste la vérité en base et sert au tri, à la recherche et aux filtres.
    { id: 'debit',        label: 'Débit',       field: 'debit',       type: 'number', width: 112, description: 'Sortie d’argent (montant négatif du relevé).' },
    { id: 'credit',       label: 'Crédit',      field: 'credit',      type: 'number', width: 112, description: 'Entrée d’argent (montant positif du relevé).' },
    { id: 'amount',       label: 'Montant',     field: 'amount',      type: 'number', width: 120, defaultVisible: false },
    { id: 'balance',      label: 'Solde',       field: 'balance',     type: 'number', width: 124 },
    { id: 'status',       label: 'Statut',      field: 'status',      type: 'single_select', width: 132, options: ['a_traiter', 'facture_recue', 'comptabilise', 'rapproche', 'ignore'], description: "Dérivé automatiquement : rouge = aucun document trouvé (facture manquante), bleu = document apparié pas encore publié à QB, jaune = publié à QB, vert = rapproché avec le relevé." },
    { id: 'matched_label', label: 'Document',   field: 'matched_label', width: 200 },
    { id: 'match_confidence', label: 'Confiance', field: 'match_confidence', type: 'number', defaultVisible: false },
    // Rarement rempli, et il poussait les boutons d'action hors de l'écran.
    { id: 'comment',      label: 'Commentaire', field: 'comment', defaultVisible: false },
    { id: 'reconciled_by_name', label: 'Rapproché par', field: 'reconciled_by_name', type: 'user', defaultVisible: false },
  ],

  stock_movements: [
    { id: 'created_at',     label: 'Date',           field: 'created_at',     type: 'date' },
    { id: 'product_sku',    label: 'SKU',            field: 'product_sku' },
    { id: 'product_name',   label: 'Produit',        field: 'product_name'  },
    { id: 'type',           label: 'Type',           field: 'type',           type: 'single_select', options: ['in', 'out', 'adjustment'] },
    { id: 'qty',            label: 'Quantité',       field: 'qty',            type: 'number' },
    { id: 'reason',         label: 'Raison',         field: 'reason',         type: 'single_select', options: ['Fabrication', 'Utilisation pour le reconditionnement', 'Ajustement (augmentation)', 'Ajustement (diminution)', 'Utilisation de pièces usagés', 'Prélèvement pour R&D'] },
    { id: 'unit_cost',      label: 'Coût unitaire',  field: 'unit_cost',      type: 'number' },
    { id: 'movement_value', label: 'Valeur',         field: 'movement_value', type: 'number', description: 'Valeur du mouvement = quantité × coût unitaire.' },
    { id: 'user_name',      label: 'Utilisateur',    field: 'user_name',      type: 'user', defaultVisible: false },
    { id: 'reference_id',   label: 'Référence',      field: 'reference_id',   defaultVisible: false },
  ],

  // Historique des mouvements de stock affiché sur la fiche produit (un seul produit) :
  // pas de colonnes produit (SKU/nom) puisque la fiche concerne déjà un produit unique.
  product_movements: [
    { id: 'created_at',     label: 'Date',          field: 'created_at',     type: 'date' },
    { id: 'type',           label: 'Type',          field: 'type',           type: 'single_select', options: ['in', 'out', 'adjustment'] },
    { id: 'qty',            label: 'Qté',           field: 'qty',            type: 'number' },
    { id: 'reason',         label: 'Raison',        field: 'reason',         type: 'single_select', options: ['Fabrication', 'Utilisation pour le reconditionnement', 'Ajustement (augmentation)', 'Ajustement (diminution)', 'Utilisation de pièces usagés', 'Prélèvement pour R&D'] },
    { id: 'user_name',      label: 'Utilisateur',   field: 'user_name',      type: 'user' },
    { id: 'unit_cost',      label: 'Coût unitaire', field: 'unit_cost',      type: 'number', defaultVisible: false },
    { id: 'movement_value', label: 'Valeur',        field: 'movement_value', type: 'number', defaultVisible: false },
    { id: 'reference_id',   label: 'Référence',     field: 'reference_id',                  defaultVisible: false },
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
    { id: 'role',   label: 'Rôle',        field: 'role',   type: 'single_select', options: ['admin', 'rh', 'sales', 'support', 'ops'] },
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

  company_orders: [
    { id: 'order_number', label: '# Commande', field: 'order_number'  },
    { id: 'status',       label: 'Statut',     field: 'status', type: 'single_select', options: ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'Drop ship seulement', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'] },
    { id: 'items_count',  label: 'Articles',   field: 'items_count', type: 'number', groupable: false, sortable: false },
    { id: 'created_at',   label: 'Date',       field: 'created_at', type: 'date' },
  ],

  company_tickets: [
    { id: 'title',      label: 'Titre',  field: 'title' },
    { id: 'type',       label: 'Type',   field: 'type', type: 'single_select', options: ['question', 'bug', 'feature', 'installation', 'maintenance', 'autre'] },
    { id: 'status',     label: 'Statut', field: 'status', type: 'single_select', options: ['open', 'in_progress', 'resolved', 'closed'] },
    { id: 'created_at', label: 'Date',   field: 'created_at', type: 'date' },
  ],

  company_factures: [
    { id: 'document_number',       label: 'N° document', field: 'document_number' },
    { id: 'status',                label: 'Statut',      field: 'status', type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',         label: 'Date',        field: 'document_date', type: 'date' },
    { id: 'amount_before_tax_cad', label: 'Total HT',    field: 'amount_before_tax_cad', type: 'number' },
    { id: 'currency',              label: 'Devise',      field: 'currency', type: 'single_select', options: ['CAD', 'USD', 'EUR'] },
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
    { id: 'n_de_retour',       label: 'N° RMA',      field: 'n_de_retour' },
    { id: 'status',            label: 'Statut',      field: 'status', type: 'single_select', options: ['Ouvert', 'En cours', 'Fermé'] },
    { id: 'contact_name',      label: 'Contact',     field: 'contact_first_name'  },
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
    { id: 'runs_30d',        label: 'Runs (30j)',  field: 'runs_30d', type: 'number', description: 'Nombre de déclenchements de l\'automation sur les 30 derniers jours.' },
    { id: 'health',          label: 'Santé',       field: 'errors_30d', type: 'number', sortable: true, description: 'Nombre d\'exécutions en erreur sur les 30 derniers jours. 0 = en bonne santé.' },
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
    { id: 'pain_points_count', label: 'Pains',         field: 'pain_points_count', type: 'number', description: 'Nombre de points de douleur (pain points) relevés pendant l\'appel de qualification.' },
    { id: 'red_flags_count',   label: 'Red flags',     field: 'red_flags_count',   type: 'number', description: 'Nombre de signaux d\'alerte (red flags) identifiés pendant l\'appel.' },
    { id: 'quote_paid_at',     label: 'Payé',          field: 'quote_paid_at',     type: 'date' },
    { id: 'source',            label: 'Source',        field: 'source',            type: 'single_select', options: ['ERP', 'Airtable'] },
    { id: 'summary',           label: 'Résumé',        field: 'summary',           defaultVisible: false },
    { id: 'next_steps',        label: 'Suite',         field: 'next_steps',        defaultVisible: false },
    { id: 'heard_about',       label: 'Source du lead', field: 'heard_about',      defaultVisible: false },
    { id: 'created_at',        label: 'Créé le',       field: 'created_at',        type: 'date', defaultVisible: false },
  ],

  discovery_forms: [
    { id: 'company_name',         label: 'Entreprise',       field: 'company_name'  },
    { id: 'status',               label: 'Statut',           field: 'status', type: 'single_select', options: ['in_progress', 'submitted'] },
    { id: 'num_greenhouses',      label: 'Nb serres',        field: 'num_greenhouses', type: 'number' },
    { id: 'chief_grower_count',   label: 'Chief',            field: 'chief_grower_count', type: 'number' },
    { id: 'helper_count',         label: 'Helper',           field: 'helper_count', type: 'number' },
    { id: 'submitted_at',         label: 'Soumis le',        field: 'submitted_at', type: 'date' },
    { id: 'created_at',           label: 'Créé le',          field: 'created_at', type: 'date' },
    { id: 'public_link',          label: 'Lien public',      field: 'public_token', sortable: false, filterable: false, groupable: false },
  ],

  public_files: [
    { id: 'original_name',    label: 'Nom du fichier',  field: 'original_name' },
    { id: 'folder',           label: 'Dossier',         field: 'folder' },
    { id: 'description',      label: 'Description',     field: 'description' },
    { id: 'tags',             label: 'Étiquettes',      field: 'tags', sortable: false },
    { id: 'mime_type',        label: 'Type',            field: 'mime_type', defaultVisible: false },
    { id: 'size',             label: 'Taille',          field: 'size', type: 'number' },
    { id: 'uploaded_by_name', label: 'Téléversé par',   field: 'uploaded_by_name', defaultVisible: false },
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
    { id: 'created_at',      label: 'Téléversé le',   field: 'created_at', type: 'date', defaultVisible: false },
    { id: 'archived_at',     label: 'Archivé le',     field: 'archived_at', type: 'date', defaultVisible: false },
    { id: 'read_at',         label: 'Lu le',          field: 'read_at', type: 'date', defaultVisible: false, description: 'Date de première ouverture du document. Vide = jamais consulté (point bleu dans la liste).' },
  ],
}
