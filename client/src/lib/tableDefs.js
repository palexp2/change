// Métadonnées des colonnes par table — partagées entre les pages et l'admin.
// Les fonctions render() restent dans les composants de page.
// Ce fichier est la source de vérité pour : id, label, field, visibilité, tri, filtre, group.

export const TABLE_LABELS = {
  companies:      'Entreprises',
  contacts:       'Contacts',
  projects:       'Projets',
  products:       'Produits',
  orders:         'Commandes',
  interactions:   'Interactions',
  tickets:        'Billets',
  purchases:      'Achats',
  serial_numbers: 'Numéros de série',
  retours:        'Retours',
  factures:       'Factures',
  abonnements:    'Abonnements',
  assemblages:    'Assemblages',
  shipments:      'Envois',
}

export const TABLE_ALL_LABEL = {
  companies:      'Toutes les entreprises',
  contacts:       'Tous les contacts',
  projects:       'Tous les projets',
  products:       'Tous les produits',
  orders:         'Toutes les commandes',
  interactions:   'Toutes les interactions',
  tickets:        'Tous les billets',
  purchases:      'Tous les achats',
  serial_numbers: 'Tous les numéros de série',
  retours:        'Tous les retours',
  factures:       'Toutes les factures',
  abonnements:    'Tous les abonnements',
  assemblages:    'Tous les assemblages',
  shipments:      'Tous les envois',
}

// Chaque entrée : { id, label, field, type?, options?, sortable?, filterable?, groupable?, defaultVisible? }
// type: 'text' (défaut) | 'number' | 'date' | 'boolean' | 'single_select'
export const TABLE_COLUMN_META = {
  companies: [
    { id: 'name',            label: 'Entreprise',   field: 'name' },
    { id: 'type',            label: 'Type',         field: 'type',            type: 'single_select', options: ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre'] },
    { id: 'phone',           label: 'Téléphone',    field: 'phone' },
    { id: 'lifecycle_phase', label: 'Phase',        field: 'lifecycle_phase', type: 'single_select', options: ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore'] },
    { id: 'contacts_count',  label: 'Contacts',     field: 'contacts_count',  type: 'number', groupable: false, sortable: false },
  ],

  contacts: [
    { id: 'full_name',    label: 'Nom',         field: 'first_name' },
    { id: 'company_name', label: 'Entreprise',  field: 'company_name' },
    { id: 'email',        label: 'Courriel',    field: 'email' },
    { id: 'phone',        label: 'Téléphone',   field: 'phone' },
    { id: 'mobile',       label: 'Cellulaire',  field: 'mobile',    defaultVisible: false },
    { id: 'language',     label: 'Langue',      field: 'language',  type: 'single_select', options: ['French', 'English'] },
  ],

  projects: [
    { id: 'name',        label: 'Projet',       field: 'name' },
    { id: 'company_name',label: 'Entreprise',   field: 'company_name' },
    { id: 'type',        label: 'Type',         field: 'type',      type: 'single_select', options: ['New Installation', 'Expansion', 'Replacement', 'Renewal', 'Service', 'Autre'] },
    { id: 'status',      label: 'Statut',       field: 'status',    type: 'single_select', options: ['open', 'won', 'lost', 'on_hold'] },
    { id: 'probability', label: 'Probabilité',  field: 'probability', type: 'number' },
    { id: 'value_cad',   label: 'Valeur (CAD)', field: 'value_cad', type: 'number' },
    { id: 'close_date',  label: 'Date de clôture', field: 'close_date', type: 'date', defaultVisible: false },
    { id: 'assigned_name', label: 'Responsable',  field: 'assigned_name', defaultVisible: false },
  ],

  products: [
    { id: 'sku',       label: 'SKU',          field: 'sku' },
    { id: 'name_fr',   label: 'Nom (FR)',     field: 'name_fr' },
    { id: 'name_en',   label: 'Nom (EN)',     field: 'name_en',   defaultVisible: false },
    { id: 'type',      label: 'Type',         field: 'type',      type: 'single_select', options: ['Produit', 'Service', 'Pièce', 'Autre'] },
    { id: 'unit_cost', label: 'Coût (CAD)',   field: 'unit_cost', type: 'number', defaultVisible: false },
    { id: 'price_cad', label: 'Prix (CAD)',   field: 'price_cad', type: 'number', defaultVisible: false },
    { id: 'stock_qty', label: 'Stock',        field: 'stock_qty', type: 'number' },
    { id: 'min_stock', label: 'Stock min',    field: 'min_stock', type: 'number', defaultVisible: false },
    { id: 'order_qty', label: 'Qté à cmd',   field: 'order_qty', type: 'number', defaultVisible: false },
    { id: 'supplier',    label: 'Fournisseur',  field: 'supplier',    defaultVisible: false },
    { id: 'is_sellable', label: 'Vendable',     field: 'is_sellable', type: 'boolean', defaultVisible: false },
    { id: 'status',      label: 'Statut stock', field: 'stock_qty',   sortable: false, filterable: false, groupable: false },
    { id: 'adjust',    label: '',             field: null,        sortable: false, filterable: false, groupable: false },
  ],

  orders: [
    { id: 'order_number',  label: '# Commande',  field: 'order_number' },
    { id: 'company_name',  label: 'Entreprise',  field: 'company_name' },
    { id: 'status',        label: 'Statut',      field: 'status',   type: 'single_select', options: ['draft', 'confirmed', 'shipped', 'delivered', 'cancelled'] },
    { id: 'priority',      label: 'Priorité',    field: 'priority', type: 'single_select', options: ['low', 'normal', 'high', 'urgent'] },
    { id: 'items_count',   label: 'Items',       field: 'items_count', type: 'number', groupable: false, sortable: false },
    { id: 'assigned_name', label: 'Assigné à',   field: 'assigned_name', defaultVisible: false },
  ],

  tickets: [
    { id: 'title',         label: 'Titre',      field: 'title' },
    { id: 'company_name',  label: 'Entreprise', field: 'company_name' },
    { id: 'status',        label: 'Statut',     field: 'status', type: 'single_select', options: ['open', 'in_progress', 'resolved', 'closed'] },
    { id: 'type',          label: 'Type',       field: 'type',   type: 'single_select', options: ['question', 'bug', 'feature', 'installation', 'maintenance', 'autre'] },
    { id: 'assigned_name', label: 'Assigné à',  field: 'assigned_name' },
    { id: 'duration_minutes', label: 'Durée (min)', field: 'duration_minutes', type: 'number', defaultVisible: false },
  ],

  purchases: [
    { id: 'product_name',  label: 'Produit',     field: 'product_name' },
    { id: 'supplier',      label: 'Fournisseur', field: 'supplier' },
    { id: 'status',        label: 'Statut',      field: 'status', type: 'single_select', options: ['pending', 'ordered', 'partial', 'received', 'cancelled'] },
    { id: 'qty_ordered',   label: 'Qté commandée', field: 'qty_ordered', type: 'number' },
    { id: 'qty_received',  label: 'Qté reçue',   field: 'qty_received', type: 'number' },
    { id: 'order_date',    label: "Date commande", field: 'order_date', type: 'date' },
    { id: 'expected_date', label: 'Date prévue',  field: 'expected_date', type: 'date', defaultVisible: false },
  ],

  serial_numbers: [
    { id: 'serial',        label: 'Numéro de série', field: 'serial' },
    { id: 'product_name',  label: 'Produit',         field: 'product_name' },
    { id: 'company_name',  label: 'Entreprise',      field: 'company_name' },
    { id: 'status',        label: 'Statut',          field: 'status', type: 'single_select', options: ['active', 'inactive', 'returned', 'lost'] },
    { id: 'manufacture_date', label: 'Date fab.',    field: 'manufacture_date', type: 'date', defaultVisible: false },
  ],

  interactions: [
    { id: 'type',         label: 'Type',        field: 'type',      type: 'single_select', options: ['call', 'email', 'meeting', 'note', 'sms'] },
    { id: 'direction',    label: 'Direction',   field: 'direction', type: 'single_select', options: ['inbound', 'outbound'] },
    { id: 'contact_name', label: 'Contact',     field: 'contact_name' },
    { id: 'company_name', label: 'Entreprise',  field: 'company_name' },
    { id: 'phone_number', label: 'Téléphone',   field: 'phone_number',     defaultVisible: false },
    { id: 'summary',      label: 'Résumé',      field: null,               sortable: false, filterable: false, groupable: false },
    { id: 'timestamp',    label: 'Date',        field: 'timestamp',        type: 'date' },
    { id: 'duration_seconds', label: 'Durée',   field: 'duration_seconds', type: 'number', defaultVisible: false },
    { id: 'user_name',    label: 'Utilisateur', field: 'user_name',        defaultVisible: false },
  ],

  retours: [
    { id: 'return_number',     label: 'N° de retour',         field: 'return_number' },
    { id: 'company_name',      label: 'Entreprise',           field: 'company_name' },
    { id: 'tracking_number',   label: 'Suivi',                field: 'tracking_number' },
    { id: 'processing_status', label: 'Statut de traitement', field: 'processing_status', type: 'single_select', options: ['Reçu', 'En attente', 'En traitement', 'Refusé'] },
    { id: 'created_at',        label: 'Date',                 field: 'created_at', type: 'date' },
  ],

  factures: [
    { id: 'document_number', label: 'N° document',    field: 'document_number' },
    { id: 'company_name',    label: 'Entreprise',     field: 'company_name' },
    { id: 'project_name',    label: 'Projet',         field: 'project_name',    defaultVisible: false },
    { id: 'status',          label: 'Statut',         field: 'status',          type: 'single_select', options: ['Payée', 'Partielle', 'En retard', 'Envoyée', 'Brouillon', 'Annulée'] },
    { id: 'document_date',   label: 'Date document',  field: 'document_date',   type: 'date' },
    { id: 'due_date',        label: 'Échéance',       field: 'due_date',        type: 'date', defaultVisible: false },
    { id: 'total_cad',       label: 'Total',          field: 'total_cad',       type: 'number' },
    { id: 'balance_due_cad', label: 'Solde dû',       field: 'balance_due_cad', type: 'number' },
  ],

  abonnements: [
    { id: 'company_name', label: 'Entreprise', field: 'company_name' },
    { id: 'type',         label: 'Type',       field: 'type' },
    { id: 'status',       label: 'Statut',     field: 'status', type: 'single_select', options: ['Actif', 'Inactif', 'Suspendu', 'Annulé', 'Expiré'] },
    { id: 'amount_cad',   label: 'Montant',    field: 'amount_cad', type: 'number' },
    { id: 'start_date',   label: 'Début',      field: 'start_date', type: 'date' },
    { id: 'end_date',     label: 'Fin',        field: 'end_date',   type: 'date', defaultVisible: false },
  ],

  assemblages: [
    { id: 'product_name', label: 'Produit',         field: 'product_name' },
    { id: 'qty_produced', label: 'Qté produite',    field: 'qty_produced', type: 'number' },
    { id: 'assembled_at', label: 'Date assemblage', field: 'assembled_at', type: 'date' },
  ],

  shipments: [
    { id: 'order_number',    label: '# Commande',   field: 'order_number' },
    { id: 'company_name',    label: 'Entreprise',   field: 'company_name' },
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'status',          label: 'Statut',       field: 'status', type: 'single_select', options: ['À envoyer', 'Envoyé'] },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at',  type: 'date' },
    { id: 'created_at',      label: 'Créé le',      field: 'created_at',  type: 'date' },
  ],
}
