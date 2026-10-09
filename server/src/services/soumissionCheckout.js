import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { ensureStripeCustomer, getOrCreateTaxRate } from './stripeInvoices.js'
import { suggestTaxRegime, taxesForRegime } from './taxes.js'
import { totalsOf } from './soumissionPdf.js'
import { assertStripeCurrency } from './stripeCustomerCompany.js'
import { stripeProductFor } from './stripeCatalog.js'
import { markUpgradeInvoice } from './facturePaidSlackWatcher.js'

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

// Soumission valide → lignes Stripe, coupon de rabais et metadata, communs au
// Checkout (nouvel abonnement / achat) et à l'ajout à un abonnement existant.
// Soumission expirée : lignes du catalogue dont le prix (du choix payé, dans la
// devise de la soumission) a changé depuis. Les lignes sur mesure gardent le leur.
function priceChanges(items, { monthly, usd, isFr }) {
  const field = monthly ? (usd ? 'monthly_price_usd' : 'monthly_price_cad') : (usd ? 'price_usd' : 'price_cad')
  const out = []
  for (const it of items) {
    if (!it.catalog_product_id) continue
    const p = db.prepare('SELECT price_cad, price_usd, monthly_price_cad, monthly_price_usd FROM products WHERE id=? AND deleted_at IS NULL').get(it.catalog_product_id)
    if (!p) continue
    const before = Number(monthly ? it.unit_monthly_price : it.unit_price_cad) || 0
    const now = Number(p[field]) || 0
    if (Math.round(before * 100) === Math.round(now * 100)) continue
    out.push({
      item_id: it.id, qty: Math.max(1, Math.round(Number(it.qty) || 1)), before, now,
      name: String((isFr ? (it.description_fr || it.name_fr) : (it.description_en || it.name_en || it.description_fr)) || it.sku || 'Article')
        + (it.group_name ? ` (${it.group_name})` : ''),
    })
  }
  return out
}

async function soumissionCharge({ stripe, soumissionId, kind, acceptNewPrices = false }) {
  const s = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(soumissionId)
  if (!s) throw Object.assign(new Error('Soumission introuvable'), { code: 'not_found' })
  const monthly = kind === 'abonnement'
  const isFr = s.language !== 'English'
  const currency = s.currency === 'USD' ? 'usd' : 'cad'
  let items = db.prepare(ITEMS_QUERY).all(s.id)
  // Au-delà du « Valide jusqu'au » du PDF (Charles, 2026-10-09) : mêmes prix
  // qu'au catalogue → on paie comme si de rien n'était ; sinon le client voit
  // les changements et accepte les prix du jour avant de payer.
  if (s.expiration_date && s.expiration_date.slice(0, 10) < new Date().toISOString().slice(0, 10)) {
    const changes = priceChanges(items, { monthly, usd: currency === 'usd', isFr })
    if (changes.length && !acceptNewPrices) {
      throw Object.assign(new Error('Prix changés'), { code: 'price_changed', changes, isFr, currency })
    }
    const now = new Map(changes.map(c => [c.item_id, c.now]))
    items = items.map(it => (now.has(it.id) ? { ...it, [monthly ? 'unit_monthly_price' : 'unit_price_cad']: now.get(it.id) } : it))
  }
  const unit = it => Number(monthly ? it.unit_monthly_price : it.unit_price_cad) || 0

  await assertStripeCurrency(stripe, s.company_id, currency)
  const place = taxPlace(s.company_id)
  if (!place) throw Object.assign(new Error('Province de taxation inconnue'), { code: 'no_tax_place' })
  const taxRateIds = []
  for (const t of taxesForRegime(suggestTaxRegime(place), 0)) {
    taxRateIds.push(await getOrCreateTaxRate(stripe, t))
  }

  const lineName = it => String((isFr ? (it.description_fr || it.name_fr) : (it.description_en || it.name_en || it.description_fr)) || it.sku || 'Article').slice(0, 250)
  // Produit Stripe dans la langue de la soumission (nom lu par le client).
  const payable = items.filter(it => unit(it) > 0)
    .map(it => ({ ...it, stripe_product_id: stripeProductFor(it.catalog_product_id, isFr ? 'fr' : 'en') }))
  // Produit relié au catalogue de vente : la ligne porte SON produit Stripe
  // (automatisations « abonnement contient tel produit »), sinon un produit à la volée.
  const line_items = payable.map(it => ({
    quantity: Math.max(1, Math.round(Number(it.qty) || 1)),
    price_data: {
      currency,
      unit_amount: Math.round(unit(it) * 100),
      ...(monthly ? { recurring: { interval: 'month' } } : {}),
      ...(it.stripe_product_id ? { product: it.stripe_product_id } : {
        product_data: {
          name: lineName(it),
          ...(it.group_name ? { description: String(it.group_name).slice(0, 250) } : {}),
          ...(it.catalog_product_id ? { metadata: { erp_product_id: it.catalog_product_id } } : {}),
        },
      }),
    },
    ...(taxRateIds.length ? { tax_rates: taxRateIds } : {}),
  }))
  const lineLabels = payable.map(it => (it.group_name ? `${lineName(it)} (${it.group_name})` : lineName(it)))
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
  return { s, isFr, currency, line_items, lineLabels, discounts, offCents, metadata }
}

/**
 * Crée la session Checkout d'une soumission.
 * @returns {Promise<{ url: string }>}
 * @throws Error avec `.code` : not_found | expired | empty | no_tax_place | currency_mismatch
 */
export async function createSoumissionCheckout({ stripe, soumissionId, kind, acceptNewPrices = false }) {
  const monthly = kind === 'abonnement'
  const { s, isFr, line_items, discounts, metadata } = await soumissionCharge({ stripe, soumissionId, kind, acceptNewPrices })
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

// ── Client déjà abonné : les lignes de la soumission s'ajoutent à son
// abonnement Stripe actif (décision de Charles, 2026-10-09) au lieu d'en
// créer un second. Le client approuve sur une page de comparaison ; l'écart
// du mois en cours est facturé au prorata sur sa carte enregistrée.

const LIVE_SUB_STATUSES = new Set(['active', 'trialing'])

async function activeSubscription(stripe, companyId, currency) {
  const customer = companyId
    ? db.prepare('SELECT stripe_customer_id FROM companies WHERE id = ?').get(companyId)?.stripe_customer_id
    : null
  // Les lignes « S'abonner » d'une soumission sont mensuelles.
  return activeSubscriptionOf(stripe, customer, currency, 'month')
}

/** Abonnements actifs d'un client Stripe, du plus récent au plus ancien. */
export async function liveSubscriptionsOf(stripe, customer) {
  if (!customer) return []
  const { data } = await stripe.subscriptions.list({ customer, status: 'all', limit: 20, expand: ['data.items.data.price'] })
  return data.filter(sub => LIVE_SUB_STATUSES.has(sub.status) && !sub.cancel_at_period_end).sort((a, b) => b.created - a.created)
}

// Fréquence d'un abonnement (Stripe exige la même pour toutes ses lignes).
export const subInterval = sub => sub.items.data[0]?.price?.recurring?.interval || null

/**
 * Abonnement actif le plus récent d'un client Stripe, dans `currency` et à la
 * fréquence `interval` si données : un produit mensuel ne s'ajoute pas à un
 * abonnement annuel (Charles, 2026-10-09 : nouvel abonnement mensuel à part).
 */
export async function activeSubscriptionOf(stripe, customer, currency = null, interval = null) {
  return (await liveSubscriptionsOf(stripe, customer))
    .find(sub => (!currency || sub.currency === currency) && (!interval || subInterval(sub) === interval)) || null
}

/**
 * Comparaison abonnement actuel / ajout de la soumission. null = aucun
 * abonnement actif : le lien « S'abonner » garde le Checkout habituel.
 */
export async function previewSoumissionUpgrade({ stripe, soumissionId, acceptNewPrices = false }) {
  const charge = await soumissionCharge({ stripe, soumissionId, kind: 'abonnement', acceptNewPrices })
  const sub = await activeSubscription(stripe, charge.s.company_id, charge.currency)
  if (!sub) return null
  const current = await subscriptionLines(stripe, sub)
  const added = charge.line_items.map((li, i) => ({
    name: charge.lineLabels[i],
    qty: li.quantity,
    cents: li.price_data.unit_amount * li.quantity,
  }))
  return {
    ...charge, sub, current, added,
    alreadyApplied: sub.items.data.some(i => i.metadata?.erp_soumission_id === charge.s.id),
  }
}

/** Lignes lisibles d'un abonnement (items avec price développé). */
export async function subscriptionLines(stripe, sub) {
  const productIds = [...new Set(sub.items.data.map(i => i.price?.product).filter(p => typeof p === 'string'))]
  const names = new Map()
  // Produits créés à la volée par Checkout : absents de products.list.
  await Promise.all(productIds.map(async id => {
    try { names.set(id, (await stripe.products.retrieve(id)).name) } catch { /* nom inconnu */ }
  }))
  return sub.items.data.map(i => ({
    name: names.get(i.price?.product) || i.price?.nickname || 'Article',
    qty: i.quantity || 1,
    cents: (i.price?.unit_amount || 0) * (i.quantity || 1),
  }))
}

const applying = new Set()

/**
 * Ajoute les lignes de la soumission à l'abonnement actif du client.
 * @returns {Promise<{ already?: true, sub?: object, metadata?: object }>}
 * @throws Error avec `.code` : no_subscription | payment_failed (+ ceux de soumissionCharge)
 */
export async function applySoumissionUpgrade({ stripe, soumissionId, acceptNewPrices = false }) {
  if (applying.has(soumissionId)) return { already: true }
  applying.add(soumissionId)
  try {
    const p = await previewSoumissionUpgrade({ stripe, soumissionId, acceptNewPrices })
    if (!p) throw Object.assign(new Error('Aucun abonnement actif'), { code: 'no_subscription' })
    if (p.alreadyApplied) return { already: true, sub: p.sub, metadata: p.metadata }
    const items = []
    for (const [i, li] of p.line_items.entries()) {
      const { product_data: pd, ...priceData } = li.price_data
      // Produit du catalogue : son prix actif au même montant, s'il existe.
      const same = priceData.product && db.prepare(`SELECT id FROM stripe_prices WHERE product_id=? AND active=1
        AND currency=? AND unit_amount=? AND interval='month'`).get(priceData.product, priceData.currency, priceData.unit_amount)
      const price = same || await stripe.prices.create({
        ...priceData,
        ...(pd ? {
          product_data: {
            name: p.lineLabels[i].slice(0, 250),
            // Hors catalogue : le miroir Stripe ne lui crée pas de fiche.
            metadata: { ...(pd.metadata || {}), erp_inline: '1' },
          },
        } : {}),
      })
      items.push({
        price: price.id, quantity: li.quantity,
        ...(li.tax_rates ? { tax_rates: li.tax_rates } : {}),
        metadata: { erp_soumission_id: p.s.id },
      })
    }
    // Les rabais déjà sur l'abonnement sont conservés ; celui de la soumission s'y ajoute.
    const keep = (p.sub.discounts || []).map(d => ({ discount: typeof d === 'string' ? d : d.id }))
    let sub
    try {
      sub = await stripe.subscriptions.update(p.sub.id, {
        items,
        ...(p.discounts ? { discounts: [...keep, ...p.discounts] } : {}),
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        metadata: { erp_last_soumission_id: p.s.id },
      })
    } catch (e) {
      if (e.type === 'StripeCardError' || e.code === 'card_declined' || /payment/i.test(e.message || '')) {
        throw Object.assign(new Error(e.message), { code: 'payment_failed' })
      }
      throw e
    }
    markUpgradeInvoice(sub, `soumission:${p.s.id}`)
    return { sub, metadata: p.metadata }
  } finally {
    applying.delete(soumissionId)
  }
}
