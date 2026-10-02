import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { ensureStripeCustomer, getOrCreateTaxRate } from './stripeInvoices.js'
import { suggestTaxRegime, taxesForRegime } from './taxes.js'
import { totalsOf } from './soumissionPdf.js'
import { assertStripeCurrency } from './stripeCustomerCompany.js'

// Boutons « S'abonner » / « Acheter » du PDF client d'une soumission : chacun
// pointe vers un lien permanent (soumissionPayUrl) qui ouvre une session
// Stripe Checkout neuve, bâtie sur les lignes de la soumission — abonnement
// mensuel pour l'un, paiement unique pour l'autre.

export const SOUMISSION_PAY_KINDS = ['abonnement', 'achat']

const ITEMS_QUERY = `
  SELECT di.*, p.name_fr, p.name_en, p.sku
  FROM document_items di
  LEFT JOIN products p ON di.catalog_product_id = p.id
  WHERE di.document_id = ? AND di.document_type = 'soumission'
  ORDER BY di.sort_order
`

function discountsOf(s) {
  try {
    const list = s.discounts ? JSON.parse(s.discounts) : null
    if (Array.isArray(list)) return list
  } catch { /* JSON illisible : repli sur le rabais global */ }
  const pct = s.discount_pct || 0, amount = s.discount_amount || 0
  return pct || amount ? [{ name: 'Rabais', pct, monthly: 0, amount }] : []
}

// Province de taxation : adresse de livraison, sinon n'importe quelle adresse,
// sinon la fiche entreprise. null = inconnue (on ne devine pas les taxes).
function taxPlace(companyId) {
  if (!companyId) return null
  const addr = db.prepare(`
    SELECT province, country FROM adresses
    WHERE company_id = ? AND province IS NOT NULL AND province != ''
    ORDER BY (address_type = 'Livraison') DESC, created_at DESC LIMIT 1
  `).get(companyId)
  const co = db.prepare('SELECT province, country FROM companies WHERE id = ?').get(companyId)
  const province = addr?.province || co?.province || null
  const country = addr?.country || co?.country || 'Canada'
  if (!province && /^(ca|canada)$/i.test(String(country).trim())) return null
  return { province, country }
}

// Nombre de mensualités (la 1re aujourd'hui, puis de mois en mois) facturées
// avant `until` (AAAA-MM-JJ, inclus).
function monthsBefore(until) {
  const start = new Date()
  let n = 0
  while (n < 120) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, start.getUTCDate()))
    if (d.toISOString().slice(0, 10) > until) break
    n++
  }
  return Math.max(1, n)
}

// Coupon Stripe du rabais, créé une fois par soumission / choix / montant / durée.
// months : null = toutes les mensualités ; N = les N premières.
async function discountCoupon(stripe, { soumission, kind, cents, currency, months, name }) {
  const key = `soumission_coupon_${soumission.id}_${kind}_${currency}_${cents}_${months ?? 'all'}`
  const cached = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key=?").get(key)
  if (cached?.value) return cached.value
  const coupon = await stripe.coupons.create({
    amount_off: cents, currency,
    ...(kind !== 'abonnement' ? { duration: 'once' }
      : months ? { duration: 'repeating', duration_in_months: months } : { duration: 'forever' }),
    name: String(name || 'Rabais').slice(0, 40),
    metadata: { erp_soumission_id: soumission.id },
  })
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('stripe', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(key, coupon.id)
  return coupon.id
}

/**
 * Crée la session Checkout d'une soumission.
 * @returns {Promise<{ url: string }>}
 * @throws Error avec `.code` : not_found | expired | empty | no_tax_place | currency_mismatch
 */
export async function createSoumissionCheckout({ stripe, soumissionId, kind }) {
  const s = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(soumissionId)
  if (!s) throw Object.assign(new Error('Soumission introuvable'), { code: 'not_found' })
  if (s.expiration_date && s.expiration_date.slice(0, 10) < new Date().toISOString().slice(0, 10)) {
    // La couverture du PDF annonce « Valide jusqu'au » : au-delà, les prix sont à revoir.
    throw Object.assign(new Error('Soumission expirée'), { code: 'expired' })
  }
  const monthly = kind === 'abonnement'
  const isFr = s.language !== 'English'
  const currency = s.currency === 'USD' ? 'usd' : 'cad'
  const items = db.prepare(ITEMS_QUERY).all(s.id)
  const unit = it => Number(monthly ? it.unit_monthly_price : it.unit_price_cad) || 0

  await assertStripeCurrency(stripe, s.company_id, currency)
  const place = taxPlace(s.company_id)
  if (!place) throw Object.assign(new Error('Province de taxation inconnue'), { code: 'no_tax_place' })
  const taxRateIds = []
  for (const t of taxesForRegime(suggestTaxRegime(place), 0)) {
    taxRateIds.push(await getOrCreateTaxRate(stripe, t))
  }

  const line_items = items.filter(it => unit(it) > 0).map(it => ({
    quantity: Math.max(1, Math.round(Number(it.qty) || 1)),
    price_data: {
      currency,
      unit_amount: Math.round(unit(it) * 100),
      ...(monthly ? { recurring: { interval: 'month' } } : {}),
      product_data: {
        name: String((isFr ? (it.description_fr || it.name_fr) : (it.description_en || it.name_en || it.description_fr)) || it.sku || 'Article').slice(0, 250),
        ...(it.group_name ? { description: String(it.group_name).slice(0, 250) } : {}),
        ...(it.catalog_product_id ? { metadata: { erp_product_id: it.catalog_product_id } } : {}),
      },
    },
    ...(taxRateIds.length ? { tax_rates: taxRateIds } : {}),
  }))
  if (!line_items.length) throw Object.assign(new Error('Aucune ligne à payer'), { code: 'empty' })

  // Un rabais dont la date de fin est passée ne s'applique plus.
  const today = new Date().toISOString().slice(0, 10)
  const totals = totalsOf(items, discountsOf(s).filter(d => !d.until || d.until >= today))
  const lines = totals.lines.filter(l => (monthly ? l.monthly : l.amount) > 0)
  const offCents = Math.round(lines.reduce((t, l) => t + (monthly ? l.monthly : l.amount), 0) * 100)
  // Abonnement : un rabais daté couvre les mensualités facturées avant sa date
  // de fin. Stripe n'accepte qu'un coupon par session : des durées différentes
  // ne peuvent pas être combinées.
  let months = null
  if (monthly && lines.length) {
    const spans = new Set(lines.map(l => (l.until ? monthsBefore(l.until) : null)))
    if (spans.size > 1) throw Object.assign(new Error('Rabais de durées différentes'), { code: 'mixed_discounts' })
    months = [...spans][0]
  }
  const discounts = offCents > 0
    ? [{ coupon: await discountCoupon(stripe, { soumission: s, kind, cents: offCents, currency, months, name: lines.map(l => l.name).filter(Boolean).join(', ') }) }]
    : undefined

  // Projet lu au clic (pas figé dans le PDF) : la facture Stripe et le System
  // builder s'y rattachent (stripeProjectLink.js).
  const metadata = {
    erp_soumission_id: s.id, erp_company_id: s.company_id || '', erp_soumission_kind: kind,
    ...(s.project_id ? { erp_project_id: s.project_id } : {}),
  }
  const params = customer => ({
    mode: monthly ? 'subscription' : 'payment',
    ...(customer ? { customer } : monthly ? {} : { customer_creation: 'always' }),
    line_items,
    ...(discounts ? { discounts } : {}),
    locale: isFr ? 'fr-CA' : 'en',
    // Retour de Stripe : System builder créé, puis redirection vers son lien public.
    success_url: `${APP_URL}/erp/pay/soumission/${encodeURIComponent(s.id)}/paye?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/erp/pay/soumission/${encodeURIComponent(s.id)}/annule`,
    metadata,
    ...(monthly
      ? { subscription_data: { metadata } }
      : { invoice_creation: { enabled: true, invoice_data: { metadata } } }),
  })
  const customer = s.company_id ? await ensureStripeCustomer(stripe, s.company_id) : undefined
  const session = await stripe.checkout.sessions.create(params(customer))
  return { url: session.url }
}
