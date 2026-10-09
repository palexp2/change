import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { liveSubscriptionsOf, subInterval, subscriptionLines } from './soumissionCheckout.js'
import { siblingStripeProducts } from './stripeCatalog.js'
import { getPageByToken, contactCompanyId } from './hostedPages.js'
import { ensureStripeCustomer } from './stripeInvoices.js'
import { markUpgradeInvoice } from './facturePaidSlackWatcher.js'
import { fireScheduledSubscriptionProduct } from './subscriptionProductTrigger.js'

// Page hébergée avec paiement (services/hostedPages.js) : après acceptation,
// le produit s'ajoute à l'abonnement actif de l'entreprise du signataire (page
// d'approbation, prorata sur sa carte), sinon un nouvel abonnement est créé par
// Checkout (taxes automatiques). Le contact signataire est posé sur
// l'abonnement : les automatisations « abonnement contient tel produit →
// HubSpot » le voient. Demande de Charles (2026-10-09).

const fail = (code, msg) => Object.assign(new Error(msg || code), { code })

// Prix écrits dans la page : nouveau client / client existant, en USD et CAD.
export function pageAcceptance(token, acceptanceId) {
  const page = getPageByToken(token)
  const a = page && db.prepare('SELECT * FROM page_acceptances WHERE id=? AND public_file_id=?').get(Number(acceptanceId) || 0, page.id)
  if (!a || !page.config.hasPayment) throw fail('not_found')
  return { c: { id: page.id, token: page.token, language: page.config.language, billingStart: page.config.billingStart, ...page.config.prices }, a }
}

// Contact signataire : seulement s'il a été reconnu par l'id du lien (sinon
// n'importe qui pourrait se faire passer pour un client).
function signer(a) {
  if (!a.email_verified || !a.contact_id) return null
  const ct = db.prepare('SELECT id, email FROM contacts WHERE id=?').get(a.contact_id)
  return ct ? { ...ct, company_id: contactCompanyId(ct.id) } : null
}

const productOf = item => (typeof item.price?.product === 'string' ? item.price.product : item.price?.product?.id)

// Prix d'un palier dans une devise, avec replis : autre devise du palier, puis
// ancien prix unique. strict = devise imposée (abonnement existant).
function pickPriceId(c, tier, currency, strict) {
  const other = currency === 'usd' ? 'cad' : 'usd'
  return c[`price_${tier}_${currency}`] || (strict ? null : c[`price_${tier}_${other}`])
    || (tier === 'existing' ? c[`price_new_${currency}`] : null) || null
}

/**
 * État du paiement d'une acceptation. Client existant = son entreprise est en
 * phase « Customer » ou a un abonnement actif → prix « client existant ».
 * Abonnement actif → le produit s'y ajoute (page d'approbation) ; sinon
 * nouvel abonnement (Checkout). Lien sans contact reconnu → nouveau client.
 */
export async function pagePayPlan({ stripe, token, acceptanceId }) {
  const { c, a } = pageAcceptance(token, acceptanceId)
  const contact = signer(a)
  const company = contact?.company_id
    ? db.prepare('SELECT id, lifecycle_phase, stripe_customer_id, country, currency FROM companies WHERE id=?').get(contact.company_id)
    : null
  const customer = company?.stripe_customer_id || null
  const live = await liveSubscriptionsOf(stripe, customer)
  const existing = live.length > 0 || company?.lifecycle_phase === 'Customer'
  const tier = existing ? 'existing' : 'new'
  // Devise : celle de ses abonnements, sinon celle du client Stripe, sinon le pays.
  let currency = live[0]?.currency
  // Client Stripe déjà facturé : sa devise est fixée chez Stripe, pas de repli.
  let fixed = live.length > 0
  if (!currency && customer) {
    currency = (await stripe.customers.retrieve(customer)).currency || null
    fixed = !!currency
  }
  if (!currency && company) currency = /^(us|usa|united states|états-unis|etats-unis)$/i.test(String(company.country || '').trim()) ? 'usd' : (company.currency === 'USD' ? 'usd' : 'cad')
  if (!currency) currency = c.language === 'en' ? 'usd' : 'cad'
  const priceId = pickPriceId(c, tier, currency, fixed)
  if (!priceId) throw fail('currency_mismatch')
  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] })
  if (fixed && price.currency !== currency) throw fail('currency_mismatch')
  const base = { c, a, price, contact, customer, isFr: c.language !== 'en', currency: price.currency, tier, billingStart: c.billingStart || null }
  // Déjà abonné à ce produit (n'importe quelle langue, n'importe quel abonnement).
  const same = new Set(siblingStripeProducts(price.product.id))
  const holder = live.find(s => s.items.data.some(i => same.has(productOf(i))))
    || (base.billingStart ? await scheduledHolder(stripe, live, same) : null)
  if (holder) return { ...base, sub: holder, mode: 'already' }
  // Abonnement à la même fréquence que le produit ; sinon (ex. seulement un
  // annuel) un nouvel abonnement séparé, au prix client existant.
  const sub = live.find(s => s.currency === price.currency && subInterval(s) === (price.recurring?.interval || null))
  // Premier paiement différé : l'ajout est programmé à la date (prorata du
  // premier mois, sauf si l'abonnement se renouvelle ce jour-là). Abonnement
  // déjà programmé ailleurs → abonnement séparé avec essai jusqu'à la date.
  if (!sub || (base.billingStart && sub.schedule)) {
    // Déjà abonné, mais à une autre fréquence : abonnement séparé confirmé en
    // un clic sur la carte au dossier (Charles, 2026-10-09). Pas de carte → Checkout.
    // Ancien client sans abonnement mais avec une carte au dossier : même
    // confirmation en un clic, taxes automatiques (Charles, 2026-10-09).
    const card = customer ? await cardOnFile(stripe, customer, live) : null
    const like = live.find(s => s.currency === price.currency) || null
    if (!card || (live.length && !like)) return { ...base, mode: 'new' }
    return {
      ...base, mode: 'separate', card, like,
      added: [{ name: price.product.name, qty: 1, cents: price.unit_amount || 0 }],
    }
  }
  return {
    ...base, sub, mode: 'upgrade',
    ...(base.billingStart ? { startsAt: upgradeBoundary(sub, base.billingStart.ts) } : {}),
    current: await subscriptionLines(stripe, sub),
    added: [{ name: price.product.name, qty: 1, cents: price.unit_amount || 0 }],
  }
}

// Ajout déjà programmé (calendrier Stripe) sur un des abonnements.
async function scheduledHolder(stripe, live, same) {
  for (const s of live.filter(x => x.schedule)) {
    const sch = await stripe.subscriptionSchedules.retrieve(typeof s.schedule === 'string' ? s.schedule : s.schedule.id,
      { expand: ['phases.items.price'] }).catch(() => null)
    if (sch?.phases?.some(ph => ph.end_date * 1000 > Date.now() && ph.items.some(i => same.has(productOf(i))))) return s
  }
  return null
}

/**
 * Moment de l'ajout programmé : la date voulue, facturée au prorata jusqu'au
 * renouvellement ; si l'abonnement (mensuel) se renouvelle à moins de 24 h de
 * cette date, l'ajout tombe sur ce renouvellement, sans prorata (Charles, 2026-10-09).
 */
export function upgradeBoundary(sub, ts) {
  const rec = sub.items.data[0]?.price?.recurring
  const anchor = new Date((sub.billing_cycle_anchor || 0) * 1000)
  if (rec?.interval === 'month' && (rec.interval_count || 1) === 1 && sub.billing_cycle_anchor) {
    const d = new Date(ts * 1000)
    for (const shift of [-1, 0]) {
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + shift
      const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
      const r = Date.UTC(y, m, Math.min(anchor.getUTCDate(), days), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()) / 1000
      if (Math.abs(r - ts) < 86400) return { at: r, prorate: false }
    }
  }
  return { at: ts, prorate: true }
}

// Moyen de paiement déjà utilisé : celui d'un abonnement, sinon celui du client.
async function cardOnFile(stripe, customer, live) {
  const idOf = v => (typeof v === 'string' ? v : v?.id) || null
  const cus = await stripe.customers.retrieve(customer)
  const pm = live.map(s => idOf(s.default_payment_method)).find(Boolean) || idOf(cus.invoice_settings?.default_payment_method)
  if (pm) {
    const m = await stripe.paymentMethods.retrieve(pm).catch(() => null)
    return m ? { paymentMethod: pm, brand: m.card?.brand || m.type, last4: m.card?.last4 || m.us_bank_account?.last4 || m.acss_debit?.last4 || '' } : null
  }
  const src = live.map(s => idOf(s.default_source)).find(Boolean) || idOf(cus.default_source)
  if (!src) return null
  const card = await stripe.customers.retrieveSource(customer, src).catch(() => null)
  return card ? { source: src, brand: card.brand || card.object, last4: card.last4 || '' } : null
}

function metadataOf(c, contact) {
  return { erp_page_id: c.id, ...(contact ? { erp_contact_id: contact.id } : {}) }
}

/** Nouvel abonnement : session Checkout du produit de la page. */
export async function createPageCheckout({ stripe, plan }) {
  const { c, a, price, contact, isFr } = plan
  // Entreprise connue sans client Stripe : il est créé et relié à la fiche
  // avant le paiement, sinon l'abonnement et ses factures arrivent orphelins.
  let customer = plan.customer
  if (!customer && contact?.company_id) {
    customer = await ensureStripeCustomer(stripe, contact.company_id)
    // Reçus au signataire, pas au premier contact de l'entreprise.
    if (contact.email) await stripe.customers.update(customer, { email: contact.email }).catch(() => {})
  }
  const metadata = metadataOf(c, contact)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    ...(customer
      ? { customer, customer_update: { address: 'auto', name: 'auto' } }
      : (a.email ? { customer_email: a.email } : {})),
    locale: isFr ? 'fr-CA' : 'en',
    success_url: `${APP_URL}/erp/pay/page/${encodeURIComponent(c.token)}/merci`,
    cancel_url: `${APP_URL}/erp/p/${encodeURIComponent(c.token)}`,
    metadata,
    subscription_data: { metadata, ...(plan.billingStart ? { trial_end: plan.billingStart.ts } : {}) },
  })
  return session.url
}

// Pose le contact signataire sur l'abonnement local s'il n'en a pas.
export function linkPageContact(stripeSubId, contactId) {
  if (!stripeSubId || !contactId) return
  db.prepare(`UPDATE subscriptions SET contact_id=? WHERE stripe_id=? AND (contact_id IS NULL OR contact_id='')
    AND EXISTS (SELECT 1 FROM contacts WHERE id=?)`).run(contactId, stripeSubId, contactId)
}

const applying = new Set()

/** Client déjà abonné : ajoute le produit de la page à son abonnement. */
export async function applyPageUpgrade({ stripe, token, acceptanceId }) {
  const key = `${token}:${acceptanceId}`
  if (applying.has(key)) return { already: true }
  applying.add(key)
  try {
    const plan = await pagePayPlan({ stripe, token, acceptanceId })
    if (plan.mode === 'already') return { already: true, plan }
    if (plan.mode === 'separate') return await createSeparate({ stripe, plan })
    if (plan.mode !== 'upgrade') throw fail('no_subscription')
    if (plan.startsAt) return await scheduleUpgrade({ stripe, plan })
    const { sub, price, c, contact } = plan
    // Taxes : automatiques si l'abonnement l'est, sinon celles de ses lignes.
    const taxRates = sub.automatic_tax?.enabled ? null
      : sub.items.data.find(i => i.tax_rates?.length)?.tax_rates.map(t => (typeof t === 'string' ? t : t.id))
    let updated
    try {
      updated = await stripe.subscriptions.update(sub.id, {
        items: [{ price: price.id, quantity: 1, ...(taxRates ? { tax_rates: taxRates } : {}), metadata: metadataOf(c, contact) }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        metadata: { erp_last_page_id: c.id },
      })
    } catch (e) {
      if (e.type === 'StripeCardError' || /payment/i.test(e.message || '')) throw fail('payment_failed', e.message)
      throw e
    }
    linkPageContact(updated.id, contact?.id)
    markUpgradeInvoice(updated, `page:${c.id}`)
    return { sub: updated, plan }
  } finally {
    applying.delete(key)
  }
}

// Abonnement séparé (autre fréquence) sur la carte au dossier ; taxes comme
// l'abonnement existant. Carte refusée → rien n'est créé, payment_failed.
async function createSeparate({ stripe, plan }) {
  const { like, price, c, contact, customer, card } = plan
  const auto = !like || like.automatic_tax?.enabled
  const taxRates = auto ? null
    : like.items.data.find(i => i.tax_rates?.length)?.tax_rates.map(t => (typeof t === 'string' ? t : t.id))
  const metadata = metadataOf(c, contact)
  let created
  try {
    created = await stripe.subscriptions.create({
      customer,
      items: [{ price: price.id, quantity: 1, ...(taxRates ? { tax_rates: taxRates } : {}) }],
      ...(card.paymentMethod ? { default_payment_method: card.paymentMethod } : { default_source: card.source }),
      ...(auto ? { automatic_tax: { enabled: true } } : {}),
      ...(plan.billingStart ? { trial_end: plan.billingStart.ts } : {}),
      payment_behavior: 'error_if_incomplete',
      metadata,
    })
  } catch (e) {
    if (e.type === 'StripeCardError' || /payment|card/i.test(e.message || '')) throw fail('payment_failed', e.message)
    // Sans abonnement modèle (ex. adresse insuffisante pour les taxes) → Checkout.
    if (!like) throw fail('needs_checkout', e.message)
    throw e
  }
  linkPageContact(created.id, contact?.id)
  return { sub: created, plan, separate: true }
}

const idOf = v => (typeof v === 'string' ? v : v?.id) || null
const discountsOf = list => (list || []).map(d => (d.discount ? { discount: idOf(d.discount) }
  : d.promotion_code ? { promotion_code: idOf(d.promotion_code) } : { coupon: idOf(d.coupon) }))
const itemOf = i => ({
  price: idOf(i.price), quantity: i.quantity ?? 1,
  ...(i.tax_rates?.length ? { tax_rates: i.tax_rates.map(idOf) } : {}),
  ...(i.discounts?.length ? { discounts: discountsOf(i.discounts) } : {}),
  ...(i.metadata && Object.keys(i.metadata).length ? { metadata: i.metadata } : {}),
})

// Ajout programmé à plan.startsAt : calendrier Stripe à deux phases (lignes
// actuelles, puis lignes actuelles + produit), relâché ensuite. Échec →
// calendrier relâché, l'abonnement reste tel quel.
async function scheduleUpgrade({ stripe, plan }) {
  const { sub, price, c, contact, startsAt } = plan
  const taxRates = sub.automatic_tax?.enabled ? null
    : sub.items.data.find(i => i.tax_rates?.length)?.tax_rates.map(idOf)
  const sched = await stripe.subscriptionSchedules.create({ from_subscription: sub.id })
  try {
    const p0 = sched.phases[0]
    const common = {
      ...(p0.discounts?.length ? { discounts: discountsOf(p0.discounts) } : {}),
      ...(p0.default_tax_rates?.length ? { default_tax_rates: p0.default_tax_rates.map(idOf) } : {}),
      ...(p0.automatic_tax?.enabled ? { automatic_tax: { enabled: true } } : {}),
      ...(p0.default_payment_method ? { default_payment_method: idOf(p0.default_payment_method) } : {}),
      ...(p0.collection_method ? { collection_method: p0.collection_method } : {}),
    }
    const items = p0.items.map(itemOf)
    await stripe.subscriptionSchedules.update(sched.id, {
      end_behavior: 'release',
      phases: [
        { ...common, items, start_date: p0.start_date, end_date: startsAt.at },
        {
          ...common,
          items: [...items, { price: price.id, quantity: 1, ...(taxRates ? { tax_rates: taxRates } : {}), metadata: metadataOf(c, contact) }],
          proration_behavior: startsAt.prorate ? 'always_invoice' : 'none',
          duration: { interval: 'month', interval_count: 1 },
          metadata: { erp_last_page_id: c.id },
        },
      ],
    })
  } catch (e) {
    await stripe.subscriptionSchedules.release(sched.id).catch(() => {})
    throw e
  }
  linkPageContact(sub.id, contact?.id)
  await fireScheduledSubscriptionProduct(sub.id, contact?.id, price.product.id).catch(e => console.error('[pageCheckout] hubspot', e.message))
  return { sub, plan, scheduled: true }
}
