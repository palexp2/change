export function Badge({ children, color = 'gray', size = 'sm', className = '' }) {
  const colors = {
    gray: 'bg-slate-100 text-slate-700',
    slate: 'bg-slate-200 text-slate-800',
    blue: 'bg-blue-100 text-blue-800',
    indigo: 'bg-brand-100 text-brand-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    orange: 'bg-orange-100 text-orange-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
    pink: 'bg-pink-100 text-pink-800',
    teal: 'bg-teal-100 text-teal-800',
  }
  const sizes = {
    xs: 'text-xs px-1.5 py-0.5',
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-sm px-3 py-1',
  }
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${colors[color] || colors.gray} ${sizes[size] || sizes.sm}${className ? ` ${className}` : ''}`}>
      {children}
    </span>
  )
}

export function phaseBadgeColor(phase) {
  const map = {
    'Contact': 'gray',
    'Qualified': 'slate',
    'Problem aware': 'yellow',
    'Solution aware': 'orange',
    'Lead': 'blue',
    'Quote Sent': 'purple',
    'Customer': 'green',
    'Not a Client Anymore': 'red',
  }
  return map[phase] || 'gray'
}

export function orderStatusColor(status) {
  const map = {
    'Commande vide': 'gray',
    "Gel d'envois": 'orange',
    'En attente': 'blue',
    'Items à fabriquer ou à acheter': 'yellow',
    'Tous les items sont disponibles': 'indigo',
    'Tout est dans la boite': 'purple',
    'Partiellement envoyé': 'orange',
    'JWT-config': 'blue',
    "Envoyé aujourd'hui": 'green',
    'Envoyé': 'green',
    'Drop ship seulement': 'teal',
    'ERREUR SYSTÈME': 'red',
  }
  return map[status] || 'gray'
}

// `ticketStatusColor` a été retiré avec `tickets.status` (migration 040) : un
// billet n'a plus de statut à colorer.

// ── Maps de statut partagées liste ↔ fiche détail ───────────────────────────
// Chaque map est utilisée à la fois par la page liste et la page détail du
// domaine : une seule source de vérité pour les couleurs de badge.

export const FACTURE_STATUS_COLORS = {
  'Payé': 'green',
  'Payée': 'green',
  'À payer': 'yellow',
  'Partielle': 'yellow',
  'En retard': 'red',
  'Envoyée': 'blue',
  'Draft': 'gray',
  'Brouillon': 'gray',
  'Annulée': 'red',
  'Void': 'gray',
  'Supprimé': 'gray',
  'Note de crédit': 'purple',
  'Remboursement': 'purple',
  'Uncollectible': 'red',
}

// Union des maps soumission (SoumissionDetail) et projet (ProjectDetail) :
// 'legacy' n'existe que sur les soumissions importées d'Airtable.
export const SOUMISSION_STATUS_COLORS = {
  'Brouillon': 'gray', 'Envoyée': 'blue', 'Acceptée': 'green', 'Refusée': 'red', 'Expirée': 'orange',
  'legacy': 'purple',
}

// PURCHASE_STATUS_COLORS retirée : le champ « Statut » des achats a été supprimé
// (colonne droppée, migration 032) — plus rien à colorer.

export const STRIPE_PAYOUT_STATUS_COLORS = {
  paid: 'green', pending: 'yellow', in_transit: 'blue', canceled: 'gray', failed: 'red',
}

// Statuts Stripe d'un abonnement et de ses factures → libellé + couleur.
export const SUBSCRIPTION_STATUS = {
  active: { label: 'Actif', color: 'green' },
  trialing: { label: 'Essai', color: 'blue' },
  past_due: { label: 'En retard', color: 'yellow' },
  canceled: { label: 'Annulé', color: 'red' },
}
export const STRIPE_INVOICE_STATUS = {
  paid: { label: 'Payée', color: 'green' },
  open: { label: 'Ouverte', color: 'yellow' },
  draft: { label: 'Brouillon', color: 'gray' },
}

export const INTERACTION_TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }

export const AUTOMATION_ACTION_LABELS = { slack: 'Slack', email: 'Email', task: 'Tâche', script: 'Script' }

