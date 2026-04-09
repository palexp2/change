import Stripe from 'stripe'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'

function getStripeKey() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='stripe' AND key='secret_key'"
  ).get()
  return row?.value || null
}

export function isStripeConfigured() {
  return !!getStripeKey()
}

function mapStatus(stripeStatus) {
  const map = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    trialing: 'trialing',
    unpaid: 'past_due',
    incomplete: 'past_due',
    incomplete_expired: 'canceled',
    paused: 'canceled',
  }
  return map[stripeStatus] || 'canceled'
}

function findCompanyByEmail(email) {
  if (!email) return null
  // Try contacts first
  const byContact = db.prepare(`
    SELECT c.id FROM companies c
    INNER JOIN contacts ct ON ct.company_id = c.id
    WHERE LOWER(ct.email)=LOWER(?)
    LIMIT 1
  `).get(email)
  if (byContact) return byContact.id

  // Try company email field directly
  const byCompany = db.prepare(
    "SELECT id FROM companies WHERE LOWER(email)=LOWER(?) LIMIT 1"
  ).get(email)
  return byCompany?.id || null
}

function findCompanyByName(name) {
  if (!name) return null
  const row = db.prepare(
    "SELECT id FROM companies WHERE name LIKE ? LIMIT 1"
  ).get(`%${name}%`)
  return row?.id || null
}

export async function syncStripeSubscriptions() {
  const secretKey = getStripeKey()
  if (!secretKey) throw new Error('Stripe non configuré')

  const stripe = new Stripe(secretKey)

  let created = 0
  let updated = 0

  // Collect all subscriptions via auto-paging (actifs + annulés)
  const allSubs = []
  for await (const sub of stripe.subscriptions.list({
    limit: 100,
    expand: ['data.customer', 'data.items.data.price'],
  })) {
    allSubs.push(sub)
  }
  for await (const sub of stripe.subscriptions.list({
    status: 'canceled',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price'],
  })) {
    allSubs.push(sub)
  }

  console.log(`🔄 Stripe: ${allSubs.length} abonnement(s) récupérés (actifs + annulés)`)

  for (const sub of allSubs) {
    const customer = sub.customer
    const customerId = typeof customer === 'object' ? customer.id : customer
    const customerEmail = typeof customer === 'object' ? (customer.email || null) : null
    const customerName = typeof customer === 'object' ? (customer.name || null) : null

    // Resolve company
    let companyId = findCompanyByEmail(customerEmail)
    if (!companyId && customerName) companyId = findCompanyByName(customerName)

    // If still no match, keep existing link if updating
    const existingRow = db.prepare(
      "SELECT id, company_id FROM subscriptions WHERE stripe_id=?"
    ).get(sub.id)
    if (!companyId && existingRow?.company_id) companyId = existingRow.company_id

    // Price / interval info
    const priceItem = sub.items?.data?.[0]
    const price = priceItem?.price
    const unitAmount = price?.unit_amount ?? 0
    const currency = (price?.currency ?? 'cad').toUpperCase()
    const intervalType = price?.recurring?.interval ?? 'month'
    const intervalCount = price?.recurring?.interval_count ?? 1

    // Normalize to monthly amount
    let amountMonthly = unitAmount / 100
    if (intervalType === 'year') amountMonthly = amountMonthly / 12
    else if (intervalType === 'week') amountMonthly = amountMonthly * 4.333

    const status = mapStatus(sub.status)
    const startDate = sub.start_date
      ? new Date(sub.start_date * 1000).toISOString().split('T')[0]
      : null
    const cancelDate = sub.canceled_at
      ? new Date(sub.canceled_at * 1000).toISOString().split('T')[0]
      : null
    const trialEndDate = sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString().split('T')[0]
      : null
    const stripeUrl = `https://dashboard.stripe.com/subscriptions/${sub.id}`

    if (existingRow) {
      // Detect changes and log them
      const prev = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(existingRow.id)
      const changes = []
      if (prev.status !== status) changes.push(`Statut: ${prev.status} → ${status}`)
      if (Math.abs((prev.amount_monthly || 0) - amountMonthly) > 0.01) changes.push(`Montant: ${(prev.amount_monthly || 0).toFixed(2)} → ${amountMonthly.toFixed(2)} ${currency}`)
      if (prev.cancel_date !== cancelDate) {
        if (!prev.cancel_date && cancelDate) changes.push(`Annulé le ${cancelDate}`)
        else if (prev.cancel_date && !cancelDate) changes.push('Annulation retirée')
      }
      if (prev.interval_type !== intervalType || prev.interval_count !== intervalCount) {
        changes.push(`Intervalle: ${prev.interval_count || 1} ${prev.interval_type || 'month'} → ${intervalCount} ${intervalType}`)
      }

      if (changes.length > 0) {
        db.prepare('INSERT INTO subscription_events (id, subscription_id, event_date, event_type, details) VALUES (?,?,datetime(\'now\'),?,?)')
          .run(uuid(), existingRow.id, 'update', JSON.stringify(changes))
      }

      db.prepare(`
        UPDATE subscriptions SET
          company_id=COALESCE(?,company_id),
          status=?, amount_monthly=?, currency=?,
          start_date=?, cancel_date=?, trial_end_date=?,
          stripe_url=?, customer_id=?, customer_email=?,
          interval_count=?, interval_type=?
        WHERE id=?
      `).run(
        companyId, status, amountMonthly, currency,
        startDate, cancelDate, trialEndDate,
        stripeUrl, customerId, customerEmail,
        intervalCount, intervalType,
        existingRow.id
      )
      updated++
    } else {
      const newId = uuid()
      db.prepare(`
        INSERT INTO subscriptions (
          id, company_id, stripe_id, status, amount_monthly, currency,
          start_date, cancel_date, trial_end_date, stripe_url, customer_id, customer_email,
          interval_count, interval_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        newId, companyId, sub.id, status, amountMonthly, currency,
        startDate, cancelDate, trialEndDate,
        stripeUrl, customerId, customerEmail,
        intervalCount, intervalType
      )
      db.prepare('INSERT INTO subscription_events (id, subscription_id, event_date, event_type, details) VALUES (?,?,?,?,?)')
        .run(uuid(), newId, startDate || new Date().toISOString(), 'creation', JSON.stringify([`Création: ${amountMonthly.toFixed(2)} ${currency}/${intervalType}`]))
      created++
    }
  }

  console.log(`✅ Stripe sync terminé: ${created} créés, ${updated} mis à jour`)
  return { created, updated, total: allSubs.length }
}
