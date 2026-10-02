import db from '../db/database.js'

// Client Stripe ↔ entreprise. Un client Stripe n'a qu'une devise : une
// soumission ou facture dans une autre devise que la sienne est refusée
// (assertStripeCurrency) plutôt que de dédoubler le client.

// Clients secondaires créés avant cette règle (clé alt_customer_<cus_…>) :
// leurs paiements restent rattachés à l'entreprise.
export function companyIdForStripeCustomer(customerId) {
  if (!customerId) return null
  const main = db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)
  if (main) return main.id
  return db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key=?").get(`alt_customer_${customerId}`)?.value || null
}

function isoCountry(c) {
  const v = String(c || '').trim()
  if (/^(ca|canada)$/i.test(v)) return 'CA'
  if (/^(us|usa|united states|états-unis|etats-unis)$/i.test(v)) return 'US'
  return /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : undefined
}

function stripeAddress(a) {
  if (!a) return null
  const line1 = a.adresse_ligne_1 || a.line1
  if (!line1) return null
  return {
    line1: String(line1).slice(0, 200),
    city: a.city || undefined,
    state: a.province || undefined,
    postal_code: a.postal_code || undefined,
    country: isoCountry(a.country),
  }
}

// Adresses de facturation et de livraison de la fiche entreprise (les plus
// récentes de chaque type), au format Stripe.
export function companyStripeAddresses(companyId) {
  const pick = type => db.prepare(`
    SELECT * FROM adresses WHERE company_id = ? AND address_type = ?
    ORDER BY updated_at DESC, created_at DESC LIMIT 1
  `).get(companyId, type)
  const billing = stripeAddress(pick('Facturation'))
  const shipping = stripeAddress(pick('Livraison'))
  return { billing: billing || shipping, shipping: shipping || billing }
}

export function stripeCustomerFields(co) {
  const { billing, shipping } = companyStripeAddresses(co.id)
  return {
    name: co.name,
    ...(billing ? { address: billing } : {}),
    ...(shipping ? { shipping: { name: co.name, address: shipping } } : {}),
  }
}

// Devise du client Stripe de l'entreprise (null : pas de client, ou aucune
// devise encore fixée par Stripe).
export async function stripeCurrencyOf(stripe, companyId) {
  const cus = db.prepare('SELECT stripe_customer_id FROM companies WHERE id=?').get(companyId)?.stripe_customer_id
  if (!cus) return null
  const c = await stripe.customers.retrieve(cus).catch(() => null)
  return c && !c.deleted && c.currency ? c.currency.toUpperCase() : null
}

export async function assertStripeCurrency(stripe, companyId, currency) {
  if (!companyId || !currency) return
  const locked = await stripeCurrencyOf(stripe, companyId)
  if (locked && locked !== String(currency).toUpperCase()) {
    throw Object.assign(
      new Error(`Ce client paie en ${locked} dans Stripe : impossible de lui facturer en ${String(currency).toUpperCase()}.`),
      { code: 'currency_mismatch', locked })
  }
}
