import { AlertCircle, CheckCircle, Clock, RefreshCw } from 'lucide-react'

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

export function ticketStatusColor(status) {
  const map = {
    'Waiting on us': 'orange',
    'Waiting on them': 'yellow',
    'Closed': 'green',
  }
  return map[status] || 'gray'
}

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

export const PURCHASE_STATUS_COLORS = { 'Commandé': 'blue', 'Reçu partiellement': 'yellow', 'Reçu': 'green', 'Annulé': 'red' }

export const STRIPE_PAYOUT_STATUS_COLORS = {
  paid: 'green', pending: 'yellow', in_transit: 'blue', canceled: 'gray', failed: 'red',
}

export const INTERACTION_TYPE_LABELS = { call: 'Appel', email: 'Courriel', sms: 'SMS', meeting: 'Réunion', note: 'Note' }

export const AUTOMATION_ACTION_LABELS = { slack: 'Slack', email: 'Email', task: 'Tâche', script: 'Script' }

// Badge de statut de traitement d'un reçu de vente (liste + fiche détail).
export function ReceiptStatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

export function stockStatusColor(product) {
  if (!product.min_stock || product.min_stock === 0) return 'gray'
  if (product.stock_qty <= 0) return 'red'
  if (product.stock_qty <= product.min_stock) return 'red'
  if (product.stock_qty <= product.min_stock * 2) return 'yellow'
  return 'green'
}

export function stockStatusLabel(product) {
  if (!product.min_stock || product.min_stock === 0) return 'N/A'
  if (product.stock_qty <= 0) return 'Rupture'
  if (product.stock_qty <= product.min_stock) return 'Critique'
  if (product.stock_qty <= product.min_stock * 2) return 'Faible'
  return 'OK'
}
