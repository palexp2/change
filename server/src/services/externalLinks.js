// Liens profonds vers le record source dans les systèmes externes (Stripe,
// QuickBooks, Airtable). Centralise la construction d'URL pour que les routes
// détail (factures, achats, envois, payouts) exposent un objet `external_links`
// standard, rendu côté client par <SourceLinks>.
//
// Pourquoi côté serveur : les identifiants de base/table Airtable vivent dans
// `airtable_module_config` et le realm QuickBooks dans `connector_oauth` — le
// client ne les a pas. On reprend le même pattern que `qbEntityUrl`,
// `qb_deposit_url`, `quickbooks_url` déjà sérialisés ailleurs.

import db from '../db/database.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'

const STRIPE_DASH = 'https://dashboard.stripe.com'

// Construit l'URL du dashboard Stripe à partir d'un identifiant (préfixe typé).
// `fallback` (ex. colonne `lien_stripe`) gagne quand fourni.
export function buildStripeUrl(id, fallback) {
  if (fallback) return fallback
  if (!id || typeof id !== 'string') return null
  if (id.startsWith('in_')) return `${STRIPE_DASH}/invoices/${id}`
  if (id.startsWith('re_')) return `${STRIPE_DASH}/refunds/${id}`
  if (id.startsWith('ch_') || id.startsWith('pi_') || id.startsWith('py_') || id.startsWith('pyr_')) {
    return `${STRIPE_DASH}/payments/${id}`
  }
  if (id.startsWith('po_')) return `${STRIPE_DASH}/payouts/${id}`
  if (id.startsWith('sub_')) return `${STRIPE_DASH}/subscriptions/${id}`
  return null
}

// Construit l'URL Airtable d'un record (recXXX) pour un module donné, en lisant
// base_id/table_id dans airtable_module_config. Retourne null si non configuré.
export function buildAirtableUrl(module, airtableId) {
  if (!module || !airtableId) return null
  const cfg = db.prepare('SELECT base_id, table_id FROM airtable_module_config WHERE module = ?').get(module)
  if (!cfg?.base_id || !cfg?.table_id) return null
  return `https://airtable.com/${cfg.base_id}/${cfg.table_id}/${airtableId}`
}

// Assemble l'objet `external_links` standard. Ne pose que les clés résolues
// (non nulles) pour que <SourceLinks> n'affiche que les liens réellement
// ouvrables.
export function buildExternalLinks({ stripeId, stripeFallback, airtableModule, airtableId, qb } = {}) {
  const links = {}
  const stripe = buildStripeUrl(stripeId, stripeFallback)
  if (stripe) links.stripe = stripe
  const airtable = buildAirtableUrl(airtableModule, airtableId)
  if (airtable) links.airtable = airtable
  if (qb?.entity && qb?.id) {
    const url = qbEntityUrl(qb.entity, qb.id)
    if (url) links.quickbooks = url
  }
  return links
}
