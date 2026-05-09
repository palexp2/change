// Calcule le montant mensuel d'un abonnement Stripe — APRÈS rabais, AVANT taxes.
//
// Pourquoi un module dédié : sans cette source unique, deux chemins (sync
// polling dans services/stripe.js et webhook dans routes/stripe-webhooks.js)
// calculaient le même `amount_monthly` différemment :
//   - le webhook sommait `items.unit_amount × qty` (avant rabais),
//   - la sync utilisait `latestInvoice.total` (incluait les TAXES).
// Résultat : pour un sub avec taxes (Cabru, 8 mai 2026), un downgrade -13,99 $
// arrivait via webhook puis un upgrade +13,99 $ via la sync polling, alors
// que rien n'avait changé. Cf. discussion du 8 mai 2026.
//
// Convention adoptée : le montant mensuel stocké dans `subscriptions.amount_monthly`
// est le montant net du cycle (après rabais), avant taxes, normalisé au mois.

/**
 * Renvoie le montant mensuel net d'un sub Stripe.
 *
 * Préférence d'ordre, avec fallback :
 *  1. `latest_invoice.total_excluding_tax` — exact, inclut rabais et exclut taxes
 *  2. `latest_invoice.subtotal_excluding_tax` — quasi-exact (subtotal avant remises
 *     d'invoice mais après remises de subscription)
 *  3. somme des items × qty − rabais sub — pour les nouveaux subs sans facture
 *
 * Renvoie `{ amountMonthly, currency, intervalType }`.
 */
export function computeMonthlyNet(sub) {
  const items = sub?.items?.data ?? []
  const firstPrice = items[0]?.price
  const currency = (firstPrice?.currency ?? 'cad').toUpperCase()
  const intervalType = firstPrice?.recurring?.interval ?? 'month'
  const intervalCount = firstPrice?.recurring?.interval_count ?? 1

  // Helpers locaux pour normaliser un montant cycle → mensuel.
  const cycleToMonthly = (cycleAmt) => {
    if (intervalType === 'year') return cycleAmt / (12 * intervalCount)
    if (intervalType === 'week') return cycleAmt * 4.333 / intervalCount
    // 'month' (et fallback)
    return cycleAmt / intervalCount
  }

  // 1. & 2. : facture la plus récente — l'API Stripe inclut total_excluding_tax
  // depuis 2022 ; subtotal_excluding_tax est le fallback historique.
  const latestInvoice = (sub?.latest_invoice && typeof sub.latest_invoice === 'object')
    ? sub.latest_invoice
    : null
  const preTaxTotalCents = latestInvoice?.total_excluding_tax
    ?? latestInvoice?.subtotal_excluding_tax
    ?? null
  if (preTaxTotalCents != null) {
    const cycleAmount = preTaxTotalCents / 100
    return { amountMonthly: cycleToMonthly(cycleAmount), currency, intervalType }
  }

  // 3. Fallback : somme items × qty (chacun normalisé selon son propre interval),
  // puis on retire les rabais de la subscription.
  let amountMonthly = 0
  for (const item of items) {
    const p = item?.price
    const unitAmt = (p?.unit_amount ?? 0) / 100
    const qty = item?.quantity ?? 1
    const iType = p?.recurring?.interval ?? 'month'
    const iCount = p?.recurring?.interval_count ?? 1
    let monthlyPart = unitAmt * qty
    if (iType === 'year') monthlyPart = monthlyPart / (12 * iCount)
    else if (iType === 'week') monthlyPart = monthlyPart * 4.333 / iCount
    else monthlyPart = monthlyPart / iCount
    amountMonthly += monthlyPart
  }

  // Rabais de la subscription. Stripe API ≥ 2024 : sub.discounts[] de Discount,
  // chaque Discount a `coupon` directement ou via `source.coupon`. Avant 2024,
  // `sub.discount` (singulier) était utilisé.
  const discountList = Array.isArray(sub?.discounts) && sub.discounts.length > 0
    ? sub.discounts
    : (sub?.discount ? [sub.discount] : [])
  for (const d of discountList) {
    const coupon = d?.coupon || d?.source?.coupon
    if (!coupon) continue
    if (coupon.amount_off) {
      // amount_off est exprimé par cycle de facturation
      const offCycle = coupon.amount_off / 100
      amountMonthly -= cycleToMonthly(offCycle)
    } else if (coupon.percent_off) {
      amountMonthly = amountMonthly * (1 - coupon.percent_off / 100)
    }
  }

  // Plancher à 0 — un rabais ne peut pas créer un montant négatif côté MRR.
  if (amountMonthly < 0) amountMonthly = 0

  return { amountMonthly, currency, intervalType }
}
