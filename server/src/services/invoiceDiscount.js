// Rabais d'une facture en attente (pending_invoices.discount_json) : liste de
// { kind: 'percent' | 'amount', value, name }. Un ancien enregistrement peut
// contenir un objet seul (un rabais). Même calcul pour l'aperçu de la modale,
// les totaux ERP et le coupon Stripe.

const round2 = n => Math.round(n * 100) / 100

// Valide un rabais reçu du client. null = aucun rabais ; throw si invalide.
export function cleanDiscount(d) {
  if (!d || typeof d !== 'object') return null
  const kind = d.kind === 'percent' ? 'percent' : d.kind === 'amount' ? 'amount' : null
  if (!kind) return null
  const value = Number(d.value)
  if (!Number.isFinite(value) || value < 0) throw new Error('Rabais invalide')
  if (value === 0) return null
  if (kind === 'percent' && value > 100) throw new Error('Rabais supérieur à 100 %')
  const name = String(d.name || '').trim().slice(0, 40)
  return { kind, value: round2(value), ...(name ? { name } : {}) }
}

// Liste de rabais (tableau, objet seul ou rien) → tableau nettoyé, vides retirés.
export function cleanDiscounts(list) {
  const arr = Array.isArray(list) ? list : list ? [list] : []
  if (arr.length > 20) throw new Error('20 rabais au maximum')
  return arr.map(cleanDiscount).filter(Boolean)
}

export function parseDiscounts(json) {
  if (!json) return []
  try { return cleanDiscounts(JSON.parse(json)) } catch { return [] }
}

// Montant du rabais en dollars, plafonné au sous-total.
export function discountAmount(discount, subtotal) {
  if (!discount || !(subtotal > 0)) return 0
  const raw = discount.kind === 'percent' ? subtotal * discount.value / 100 : discount.value
  return round2(Math.min(subtotal, Math.max(0, raw)))
}

// Chaque rabais se calcule sur le sous-total brut ; la somme est plafonnée au
// sous-total. Renvoie les rabais avec leur montant et le total.
export function discountsBreakdown(discounts, subtotal) {
  let left = subtotal > 0 ? subtotal : 0
  const lines = (discounts || []).map(d => {
    const amount = round2(Math.min(left, discountAmount(d, subtotal)))
    left = round2(left - amount)
    return { ...d, amount }
  })
  return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) }
}

export function discountLabel(discount) {
  if (!discount) return ''
  if (discount.name) return discount.name
  return discount.kind === 'percent'
    ? `Rabais ${String(discount.value).replace('.', ',')} %`
    : 'Rabais'
}

// Sous-total brut, rabais et sous-total net (avant taxes) d'une facture en attente.
export function pendingInvoiceTotals(pending) {
  let items = []
  try { items = JSON.parse(pending.items_json || '[]') } catch { /* lignes illisibles */ }
  const subtotal = round2(items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0))
  const { lines, total } = discountsBreakdown(parseDiscounts(pending.discount_json), subtotal)
  return {
    items, subtotal,
    discount: lines[0] || null, // compat : premier rabais
    discounts: lines,
    discount_amount: total,
    net: round2(subtotal - total),
  }
}
