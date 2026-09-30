import db from '../db/database.js'

// Un client Stripe n'a qu'une devise : une entreprise payée dans une autre
// devise que son client principal reçoit un client Stripe par devise,
// enregistré ici (clé alt_customer_<cus_…> → id d'entreprise).
const altKey = customerId => `alt_customer_${customerId}`
const currencyKey = (companyId, currency) => `company_customer_${companyId}_${currency}`

export function companyIdForStripeCustomer(customerId) {
  if (!customerId) return null
  const main = db.prepare('SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1').get(customerId)
  if (main) return main.id
  return db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key=?").get(altKey(customerId))?.value || null
}

export function currencyCustomerFor(companyId, currency) {
  return db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key=?").get(currencyKey(companyId, currency))?.value || null
}

export function saveCurrencyCustomer(companyId, currency, customerId) {
  const up = db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `)
  up.run(currencyKey(companyId, currency), customerId)
  up.run(altKey(customerId), companyId)
}
