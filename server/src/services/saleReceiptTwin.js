import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { normalizeVendorKey } from './vendorProfiles.js'

// Un même achat arrive souvent en DEUX documents : la facture et le reçu de
// paiement (Stripe : « Invoice-XXXX-0008.pdf » + « Receipt-2265-1094.pdf », dans
// le même courriel). Le reçu imprime les deux numéros ; l'IA prenait le numéro
// de reçu, si bien que les deux pièces ne se reconnaissaient pas comme un doublon.

const INVOICE_RE = /(?:Invoice\s*(?:number|no\.?|#)|N(?:um[ée]ro|°|º)\s*de\s*facture)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i
const RECEIPT_RE = /(?:Receipt\s*(?:number|no\.?|#)|N(?:um[ée]ro|°|º)\s*de\s*re[çc]u)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i

// Numéro à retenir : celui de la FACTURE quand le document imprime aussi un numéro
// de reçu et que l'IA a pris ce dernier (ou rien). null = garder l'extraction.
export function preferInvoiceNumber(extractedNumber, sourceText) {
  if (!sourceText) return null
  const inv = sourceText.match(INVOICE_RE)?.[1]
  const rcp = sourceText.match(RECEIPT_RE)?.[1]
  if (!inv || !rcp || inv === rcp) return null
  const cur = String(extractedNumber || '').trim()
  return !cur || cur === rcp ? inv : null
}

// Après lecture : la jumelle du même courriel (même fournisseur, date, total,
// devise) est déjà là → cette pièce est archivée, la jumelle reste seule active
// et récupère la carte de paiement si elle ne l'avait pas. Réversible (Archives).
export function archiveSameMessageTwin(receiptId) {
  const rec = db.prepare(`SELECT id, gmail_message_id, company, total, currency, receipt_date, card_last4, payment_method, quickbooks_id
    FROM sale_receipts WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL`).get(receiptId)
  if (!rec?.gmail_message_id || rec.quickbooks_id || rec.total == null || !rec.receipt_date) return null
  const twin = db.prepare(`SELECT id, company, card_last4, payment_method FROM sale_receipts
    WHERE gmail_message_id=? AND id<>? AND status='done' AND deleted_at IS NULL AND archived_at IS NULL
      AND receipt_date=? AND COALESCE(currency,'CAD')=COALESCE(?,'CAD') AND ABS(total - ?) < 0.005
    ORDER BY created_at`).all(rec.gmail_message_id, rec.id, rec.receipt_date, rec.currency, rec.total)
    .find(t => normalizeVendorKey(t.company) === normalizeVendorKey(rec.company))
  if (!twin) return null

  if (!twin.card_last4 && rec.card_last4) {
    db.prepare('UPDATE sale_receipts SET card_last4=?, payment_method=COALESCE(payment_method, ?) WHERE id=?')
      .run(rec.card_last4, rec.payment_method, twin.id)
  }
  db.prepare("UPDATE sale_receipts SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(rec.id)
  db.prepare('INSERT INTO sale_receipt_events (id, receipt_id, user_id, action, detail) VALUES (?,?,?,?,?)')
    .run(newRecordId(), rec.id, null, 'archived', 'Même achat que l\'autre pièce du courriel')
  return twin.id
}
