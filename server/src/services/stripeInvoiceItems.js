import crypto from 'crypto'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'

// Synthétise une clé stable pour les lignes ad-hoc (sans il_xxx fourni par
// Stripe, ex. lignes de proration custom). Hash de (invoice_id + index +
// description + amount) — déterministe, donc l'upsert reste idempotent.
function syntheticLineId(invoiceId, idx, line) {
  const payload = `${invoiceId}|${idx}|${line.description || ''}|${line.amount || 0}|${line.currency || ''}`
  const hash = crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16)
  return `adhoc_${hash}`
}

// Extrait les champs nécessaires d'une ligne Stripe (objet inv.lines.data[i]).
// Tolérant aux variantes d'expansion : price/pricing peut être objet ou string null.
//
// Montants : on stocke le HT (montant avant taxes) dans `amount` et `unit_amount`.
// Pour les prix Stripe configurés `tax_behavior: "inclusive"`, `line.amount` et
// `price.unit_amount` sont TTC — `line.subtotal` (présent depuis API 2024) est
// le HT et c'est universellement la base imposable, quel que soit le tax_behavior.
export function normalizeLine(invoiceId, idx, line) {
  const stripe_line_id = line.id || syntheticLineId(invoiceId, idx, line)
  // API ≥ 2025-06 : line.pricing.price_details remplace line.price.
  const pricing = line.pricing?.price_details || null
  const price = (line.price && typeof line.price === 'object') ? line.price : null
  const stripe_price_id = pricing?.price
    || price?.id
    || (typeof line.price === 'string' ? line.price : null)
  const stripe_product_id = pricing?.product
    || (typeof price?.product === 'string' ? price.product : (price?.product?.id || null))
  const quantity = Number.isFinite(line.quantity) ? line.quantity : 1
  // HT — préfère line.subtotal (toujours HT), fallback line.amount (HT pour
  // tax_behavior=exclusive, TTC pour inclusive — accepté en dernier recours).
  const lineAmount = Number.isFinite(line.subtotal) ? line.subtotal : (line.amount ?? null)
  const unitAmount = lineAmount != null && quantity > 0
    ? Math.round(lineAmount / quantity)
    : null
  return {
    stripe_line_id,
    stripe_price_id,
    stripe_product_id,
    description: line.description || null,
    quantity,
    unit_amount: unitAmount,
    amount: lineAmount,
    currency: (line.currency || price?.currency || '').toUpperCase() || null,
    period_start: line.period?.start ? new Date(line.period.start * 1000).toISOString() : null,
    period_end: line.period?.end ? new Date(line.period.end * 1000).toISOString() : null,
    proration: line.proration ? 1 : 0,
  }
}

// Upsert idempotent. factureId peut être null si la facture locale n'existe
// pas encore — on insère quand même, le batch-enrich/backfill renseigne le lien
// au moment où le record factures est créé/résolu.
export function upsertFromInvoiceLines(factureId, invoiceId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return { inserted: 0, updated: 0 }

  const existsStmt = db.prepare('SELECT id FROM stripe_invoice_items WHERE stripe_line_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO stripe_invoice_items (
      id, facture_id, stripe_invoice_id, stripe_line_id, stripe_price_id,
      stripe_product_id, description, quantity, unit_amount, amount, currency,
      period_start, period_end, proration
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const updateStmt = db.prepare(`
    UPDATE stripe_invoice_items SET
      facture_id = COALESCE(?, facture_id),
      stripe_price_id = ?,
      stripe_product_id = ?,
      description = ?,
      quantity = ?,
      unit_amount = ?,
      amount = ?,
      currency = ?,
      period_start = ?,
      period_end = ?,
      proration = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE stripe_line_id = ?
  `)

  let inserted = 0
  let updated = 0
  const tx = db.transaction(() => {
    lines.forEach((rawLine, idx) => {
      const n = normalizeLine(invoiceId, idx, rawLine)
      const existing = existsStmt.get(n.stripe_line_id)
      if (existing) {
        updateStmt.run(
          factureId, n.stripe_price_id, n.stripe_product_id, n.description,
          n.quantity, n.unit_amount, n.amount, n.currency,
          n.period_start, n.period_end, n.proration, n.stripe_line_id
        )
        updated++
      } else {
        insertStmt.run(
          newRecordId(), factureId, invoiceId, n.stripe_line_id, n.stripe_price_id,
          n.stripe_product_id, n.description, n.quantity, n.unit_amount, n.amount, n.currency,
          n.period_start, n.period_end, n.proration
        )
        inserted++
      }
    })
  })
  tx()
  return { inserted, updated }
}
