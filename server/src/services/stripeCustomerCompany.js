import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { emitCompany, emitCompanyContactsChanged } from './realtimeEmitters.js'

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

// Rattache un client Stripe à l'entreprise (principal si libre, sinon
// secondaire via alt_customer_).
function attachStripeCustomer(companyId, customerId) {
  const co = db.prepare('SELECT stripe_customer_id FROM companies WHERE id=?').get(companyId)
  if (!co?.stripe_customer_id) {
    db.prepare("UPDATE companies SET stripe_customer_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(customerId, companyId)
  } else {
    db.prepare("INSERT OR REPLACE INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)")
      .run(`alt_customer_${customerId}`, companyId)
  }
}

// Client Stripe inconnu (paiement fait sur le site web, hors Boréal) : on le
// retrouve par son courriel. Contact connu → son entreprise principale (créée
// s'il n'en a pas). Sinon courriel d'entreprise. Sinon contact + entreprise
// créés. Renvoie { companyId, created, via } ou null (client sans courriel).
export function linkStripeCustomerByEmail(customer) {
  const customerId = customer?.id
  if (!customerId || customer.deleted) return null
  const known = companyIdForStripeCustomer(customerId)
  if (known) return { companyId: known, created: false, via: 'known' }

  const metaCo = customer.metadata?.erp_company_id
  if (metaCo && db.prepare('SELECT 1 FROM companies WHERE id=? AND deleted_at IS NULL').get(metaCo)) {
    attachStripeCustomer(metaCo, customerId)
    return { companyId: metaCo, created: false, via: 'metadata' }
  }

  const email = String(customer.email || '').trim().toLowerCase()
  if (!email) return null

  // Plusieurs contacts au même courriel : le plus ancien qui a une entreprise
  // principale l'emporte (contacts.company_id = entreprise principale).
  const ct = db.prepare(`
    SELECT ct.id, ct.first_name, ct.last_name, co.id AS company_id
    FROM contacts ct
    LEFT JOIN companies co ON co.id = ct.company_id AND co.deleted_at IS NULL
    WHERE lower(trim(ct.email)) = ? AND ct.deleted_at IS NULL
    ORDER BY co.id IS NULL, ct.created_at LIMIT 1
  `).get(email)
  if (ct?.company_id) {
    attachStripeCustomer(ct.company_id, customerId)
    return { companyId: ct.company_id, created: false, via: 'contact' }
  }

  if (!ct) {
    const co = db.prepare(`SELECT id FROM companies WHERE lower(trim(email)) = ? AND deleted_at IS NULL
                           ORDER BY created_at LIMIT 1`).get(email)
    if (co) {
      attachStripeCustomer(co.id, customerId)
      return { companyId: co.id, created: false, via: 'company' }
    }
  }

  // Entreprise neuve — et contact neuf si le courriel est inconnu.
  const fullName = String(customer.name || '').trim()
  const name = String(customer.business_name || fullName || (ct ? `${ct.first_name} ${ct.last_name}` : '')).trim() || email
  const companyId = newRecordId()
  const contactId = ct?.id || newRecordId()
  db.transaction(() => {
    db.prepare(`INSERT INTO companies (id, name, email, country, currency, stripe_customer_id)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(companyId, name, email, customer.address?.country === 'US' ? 'United States' : 'Canada',
        String(customer.currency || 'cad').toUpperCase(), customerId)
    if (ct) {
      db.prepare('UPDATE contacts SET company_id=? WHERE id=?').run(companyId, ct.id)
    } else {
      const [first, ...rest] = (fullName || email.split('@')[0]).split(/\s+/)
      db.prepare('INSERT INTO contacts (id, first_name, last_name, email, phone, company_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(contactId, first, rest.join(' '), email, customer.phone || null, companyId)
    }
    db.prepare('INSERT OR IGNORE INTO contact_companies (id, contact_id, company_id, is_primary) VALUES (?, ?, ?, 1)')
      .run(newRecordId(), contactId, companyId)
  })()
  emitCompany('created', companyId, null)
  emitCompanyContactsChanged([companyId], null)
  return { companyId, created: true, via: ct ? 'contact' : 'nouveau contact' }
}
