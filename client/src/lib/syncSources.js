// Registre central : table DataTable → sources de synchronisation externes.
// Affiché par SyncDetails (en tête des modales de mapping de champs) pour
// indiquer à l'utilisateur COMMENT les données de la table arrivent : webhook
// (temps réel), planifié (heure fixe / intervalle) ou manuel (bouton).
//
// Les horaires reflètent les planifications de server/src/index.js et le
// dispatch webhook de server/src/services/airtableWebhooks.js — à maintenir
// en phase si ces planifications changent.

// Modules Airtable branchés sur les webhooks : sync temps réel à chaque
// changement dans Airtable + sync complet de rattrapage 1×/jour.
const AIRTABLE_WEBHOOK = {
  connector: 'Airtable',
  mode: 'webhook',
  detail: 'Temps réel via webhook, plus un sync complet de rattrapage une fois par jour.',
}

export const MODE_LABELS = {
  webhook: 'webhook',
  scheduled: 'planifié',
  manual: 'manuel',
}

// Modules Airtable (clés d'AirtableCoreMapModal) dont le nom diffère de la
// table ERP correspondante — les autres modules portent le même nom que la
// table (factures, orders, paies…). Miroir de AIRTABLE_FIELD_MODULES côté
// serveur (server/src/routes/connectors.js).
export const MODULE_TO_TABLE = {
  pieces: 'products',
  serials: 'serial_numbers',
  serial_changes: 'serial_transitions',
}

export const SYNC_SOURCES = {
  // — Modules Airtable temps réel (webhook + fallback quotidien) —
  companies: [AIRTABLE_WEBHOOK],
  contacts: [AIRTABLE_WEBHOOK],
  projects: [AIRTABLE_WEBHOOK],
  products: [AIRTABLE_WEBHOOK],
  orders: [AIRTABLE_WEBHOOK],
  order_items: [AIRTABLE_WEBHOOK],
  soumissions: [AIRTABLE_WEBHOOK],
  shipments: [AIRTABLE_WEBHOOK],
  retours: [AIRTABLE_WEBHOOK],
  tickets: [AIRTABLE_WEBHOOK],
  serial_numbers: [AIRTABLE_WEBHOOK],
  serial_transitions: [AIRTABLE_WEBHOOK],
  assemblages: [AIRTABLE_WEBHOOK],
  stock_movements: [AIRTABLE_WEBHOOK],
  product_movements: [AIRTABLE_WEBHOOK],
  bom_items: [AIRTABLE_WEBHOOK],

  // — Achats fournisseurs : trois canaux d'alimentation —
  achats_fournisseurs: [
    {
      connector: 'QuickBooks',
      mode: 'scheduled',
      detail: 'Import incrémental toutes les 15 minutes, réconciliation complète (suppressions incluses) une fois par jour.',
    },
    {
      connector: 'Gmail',
      mode: 'scheduled',
      detail: 'Factures reçues par courriel (factures@orisha.io) importées toutes les heures.',
    },
    AIRTABLE_WEBHOOK,
  ],

  // — Stripe —
  factures: [
    {
      connector: 'Stripe',
      mode: 'webhook',
      detail: 'Factures créées et mises à jour en temps réel via les webhooks Stripe.',
    },
    {
      connector: 'Airtable',
      mode: 'webhook',
      detail: 'Liens projet/commande repris en temps réel via webhook.',
    },
  ],
  stripe_invoice_items: [
    {
      connector: 'Stripe',
      mode: 'webhook',
      detail: 'Items alimentés en temps réel via les webhooks Stripe (factures payées).',
    },
  ],
  abonnements: [
    {
      connector: 'Stripe',
      mode: 'webhook',
      detail: 'Temps réel via webhook, plus un sync de rattrapage une fois par jour et le bouton « Sync Stripe » de la page.',
    },
  ],
  stripe_payouts: [
    {
      connector: 'Stripe',
      mode: 'manual',
      detail: 'Bouton « Sync Stripe » en haut de la page.',
    },
    {
      connector: 'Stripe',
      mode: 'scheduled',
      detail: 'Sync + push QuickBooks chaque lundi à 12 h, si l’automatisation hebdomadaire est activée dans /automations.',
    },
  ],

  // — Sync manuels (bouton) —
  paies: [
    {
      connector: 'Airtable',
      mode: 'manual',
      detail: 'Bouton « Sync Airtable » en haut de la page (importe paies + items de paie).',
    },
  ],
  paie_items: [
    {
      connector: 'Airtable',
      mode: 'manual',
      detail: 'Bouton « Sync Airtable » en haut de la page Paies.',
    },
  ],
  employees: [
    {
      connector: 'Airtable',
      mode: 'manual',
      detail: 'Bouton « Synchroniser maintenant » dans le panneau de configuration de la page.',
    },
  ],

  // — Autres planifiés / continus —
  tasks: [
    {
      connector: 'HubSpot',
      mode: 'scheduled',
      detail: 'Pull des tâches toutes les 2 minutes ; les modifications ERP sont poussées vers HubSpot immédiatement.',
    },
  ],
  sale_receipts: [
    {
      connector: 'Gmail',
      mode: 'scheduled',
      detail: 'Reçus reçus par courriel (label ERP/Factures ou factures@orisha.io) importés toutes les heures.',
    },
  ],
  interactions: [
    {
      connector: 'Gmail',
      mode: 'scheduled',
      detail: 'Courriels importés toutes les heures.',
    },
    {
      connector: 'FTP',
      mode: 'webhook',
      detail: 'Enregistrements d’appels (Cube ARC) ingérés en continu dès leur dépôt.',
    },
  ],
}
