// Métadonnées des colonnes par table — partagées entre les pages et l'admin.
// Les fonctions render() restent dans les composants de page.
// Ce fichier est la source de vérité pour : id, label, field, visibilité, tri, filtre, group.

export const TABLE_LABELS = {
  depenses:             'Dépense',
  factures_fournisseurs: 'Facture fournisseur',
  tasks:          'Tâches',
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
  depenses:              'Toutes les dépenses',
  factures_fournisseurs: 'Toutes les factures fournisseurs',
  tasks:          'Toutes les tâches',
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
  tasks: [
    { id: 'title',         label: 'Titre',        field: 'title' },
    { id: 'status',        label: 'Statut',       field: 'status',        type: 'single_select', options: ['À faire', 'En cours', 'Terminé', 'Annulé'] },
    { id: 'priority',      label: 'Priorité',     field: 'priority',      type: 'single_select', options: ['Basse', 'Normal', 'Haute', 'Urgente'] },
    { id: 'due_date',      label: 'Échéance',     field: 'due_date',      type: 'date' },
    { id: 'company_name',  label: 'Entreprise',   field: 'company_name',  defaultVisible: true },
    { id: 'contact_name',  label: 'Contact',      field: 'contact_name',  defaultVisible: true },
    { id: 'assigned_name', label: 'Responsable',  field: 'assigned_name', defaultVisible: false },
    { id: 'created_at',    label: 'Créée le',     field: 'created_at',    type: 'date', defaultVisible: false },
  ],

  companies: [
    { id: 'name',            label: 'Entreprise',   field: 'name' },
    { id: 'type',            label: 'Type',         field: 'type',            type: 'single_select', options: ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre'] },
    { id: 'phone',           label: 'Téléphone',    field: 'phone', type: 'phone' },
    { id: 'lifecycle_phase', label: 'Phase',        field: 'lifecycle_phase', type: 'single_select', options: ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore'] },
    { id: 'contacts_count',  label: 'Contacts',     field: 'contacts_count',  type: 'number', groupable: false, sortable: false },
  ],

  contacts: [
    { id: 'full_name',    label: 'Nom',         field: 'first_name' },
    { id: 'company_name', label: 'Entreprise',  field: 'company_name' },
    { id: 'email',        label: 'Courriel',    field: 'email' },
    { id: 'phone',        label: 'Téléphone',   field: 'phone',  type: 'phone' },
    { id: 'mobile',       label: 'Cellulaire',  field: 'mobile', type: 'phone', defaultVisible: false },
    { id: 'language',     label: 'Langue',      field: 'language',  type: 'single_select', options: ['French', 'English'] },
  ],

  projects: [
    { id: 'name',           label: 'Projet',            field: 'name' },
    { id: 'company_name',   label: 'Entreprise',        field: 'company_name' },
    { id: 'type',           label: 'Type',              field: 'type',        type: 'single_select', options: ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange'] },
    { id: 'status',         label: 'Statut',            field: 'status',      type: 'single_select', options: ['Ouvert', 'Gagné', 'Perdu'] },
    { id: 'probability',    label: 'Probabilité',       field: 'probability', type: 'number', defaultVisible: false },
    { id: 'value_cad',      label: 'Valeur (CAD)',      field: 'value_cad',   type: 'number' },
    { id: 'monthly_cad',    label: 'Mensuel (CAD)',     field: 'monthly_cad', type: 'number', defaultVisible: false },
    { id: 'nb_greenhouses', label: 'Nb serres',         field: 'nb_greenhouses', type: 'number', defaultVisible: false },
    { id: 'close_date',     label: 'Date de clôture',  field: 'close_date',  type: 'date' },
    { id: 'assigned_name',  label: 'Responsable',      field: 'assigned_name', defaultVisible: false },
    { id: 'refusal_reason', label: 'Raison du refus',  field: 'refusal_reason', defaultVisible: false },
    { id: 'notes',          label: 'Notes',            field: 'notes',       defaultVisible: false },
    { id: 'created_at',     label: 'Créé le',          field: 'created_at',  type: 'date', defaultVisible: false },
    { id: 'updated_at',     label: 'Modifié le',       field: 'updated_at',  type: 'date', defaultVisible: false },
  ],

  products: [],

  orders: [
    { id: 'order_number',   label: '# Commande',       field: 'order_number' },
    { id: 'company_name',   label: 'Entreprise',        field: 'company_name' },
    { id: 'date_commande',  label: 'Date de commande',  field: 'date_commande', type: 'date' },
    { id: 'status',         label: 'Statut',            field: 'status',   type: 'single_select', options: ['Commande vide', "Gel d'envois", 'En attente', 'Items à fabriquer ou à acheter', 'Tous les items sont disponibles', 'Tout est dans la boite', 'Partiellement envoyé', 'Drop ship seulement', 'JWT-config', "Envoyé aujourd'hui", 'Envoyé', 'ERREUR SYSTÈME'] },
    { id: 'priority',       label: 'Priorité',          field: 'priority', type: 'single_select', options: ['low', 'normal', 'high', 'urgent'] },
    { id: 'items_count',    label: 'Items',             field: 'items_count', type: 'number', groupable: false, sortable: false },
    { id: 'assigned_name',  label: 'Assigné à',         field: 'assigned_name', defaultVisible: false },
  ],

  tickets: [
    { id: 'title',         label: 'Titre',      field: 'title' },
    { id: 'company_name',  label: 'Entreprise', field: 'company_name' },
    { id: 'status',        label: 'Statut',     field: 'status', type: 'single_select', options: ['open', 'in_progress', 'resolved', 'closed'] },
    { id: 'type',          label: 'Type',       field: 'type',   type: 'single_select', options: ['question', 'bug', 'feature', 'installation', 'maintenance', 'autre'] },
    { id: 'assigned_name', label: 'Assigné à',  field: 'assigned_name' },
    { id: 'duration_minutes', label: 'Durée (min)', field: 'duration_minutes', type: 'number', defaultVisible: false },
    { id: 'created_at', label: 'Créé le', field: 'created_at', type: 'date' },
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
    { id: 'status',       label: 'Statut',     field: 'status', type: 'single_select', options: ['active', 'trialing', 'past_due', 'canceled', 'Actif', 'Inactif', 'Suspendu', 'Annulé', 'Expiré'] },
    { id: 'rachat',       label: 'Rachat',     field: 'rachat', defaultVisible: false },
    { id: 'amount_cad',   label: 'Montant',    field: 'amount_cad', type: 'number' },
    { id: 'start_date',   label: 'Début',      field: 'start_date', type: 'date' },
    { id: 'end_date',     label: 'Fin',        field: 'end_date',   type: 'date', defaultVisible: false },
    { id: 'stripe_url',   label: 'Stripe',     field: 'stripe_url', defaultVisible: false, sortable: false },
  ],

  assemblages: [
    { id: 'product_name', label: 'Produit',         field: 'product_name' },
    { id: 'qty_produced', label: 'Qté produite',    field: 'qty_produced', type: 'number' },
    { id: 'assembled_at', label: 'Date assemblage', field: 'assembled_at', type: 'date' },
  ],

  depenses: [
    { id: 'date_depense',    label: 'Date',          field: 'date_depense',    type: 'date' },
    { id: 'description',     label: 'Description',   field: 'description' },
    { id: 'category',        label: 'Catégorie',     field: 'category',        type: 'single_select', options: ['Fournitures','Voyage','Repas','Loyer','Assurance','Services','Équipement','Marketing','Logiciels','Autre'] },
    { id: 'vendor',          label: 'Fournisseur',   field: 'vendor' },
    { id: 'amount_cad',      label: 'Montant',       field: 'amount_cad',      type: 'number' },
    { id: 'tax_cad',         label: 'Taxes',         field: 'tax_cad',         type: 'number', defaultVisible: false },
    { id: 'total_cad',       label: 'Total',         field: 'total_cad',       type: 'number' },
    { id: 'payment_method',  label: 'Mode de paiement', field: 'payment_method', type: 'single_select', options: ['Carte de crédit','Chèque','Virement','Comptant','Autre'], defaultVisible: false },
    { id: 'status',          label: 'Statut',        field: 'status',          type: 'single_select', options: ['Brouillon','Soumis','Approuvé','Refusé','Remboursé'] },
    { id: 'reference',       label: 'Référence',     field: 'reference',       defaultVisible: false },
  ],

  factures_fournisseurs: [
    { id: 'date_facture',         label: 'Date facture',    field: 'date_facture',         type: 'date' },
    { id: 'vendor',               label: 'Fournisseur',     field: 'vendor' },
    { id: 'bill_number',          label: '# Facture',       field: 'bill_number' },
    { id: 'vendor_invoice_number', label: '# Fact. fourn.', field: 'vendor_invoice_number', defaultVisible: false },
    { id: 'category',             label: 'Catégorie',       field: 'category',             type: 'single_select', options: ['Fournitures','Voyage','Loyer','Assurance','Services','Équipement','Marketing','Logiciels','Autre'] },
    { id: 'total_cad',            label: 'Total',           field: 'total_cad',            type: 'number' },
    { id: 'amount_paid_cad',      label: 'Payé',            field: 'amount_paid_cad',      type: 'number', defaultVisible: false },
    { id: 'balance_due_cad',      label: 'Solde dû',        field: 'balance_due_cad',      type: 'number' },
    { id: 'due_date',             label: 'Échéance',        field: 'due_date',             type: 'date' },
    { id: 'status',               label: 'Statut',          field: 'status',               type: 'single_select', options: ['Brouillon','Reçue','Approuvée','Payée partiellement','Payée','En retard','Annulée'] },
  ],

  shipments: [
    { id: 'order_number',    label: '# Commande',   field: 'order_number' },
    { id: 'company_name',    label: 'Entreprise',   field: 'company_name' },
    { id: 'tracking_number', label: 'N° de suivi',  field: 'tracking_number' },
    { id: 'carrier',         label: 'Transporteur', field: 'carrier' },
    { id: 'pays',            label: 'Pays',         field: 'pays' },
    { id: 'status',          label: 'Statut',       field: 'status', type: 'single_select', options: ['À envoyer', 'Envoyé'] },
    { id: 'shipped_at',      label: 'Envoyé le',    field: 'shipped_at',  type: 'date' },
    { id: 'created_at',      label: 'Créé le',      field: 'created_at',  type: 'date' },
  ],
}
