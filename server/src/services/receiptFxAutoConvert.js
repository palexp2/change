// Facture en USD d'un fournisseur tenu en dollars canadiens (OpenAI/ChatGPT…),
// payée d'un compte CAD : le dossier est converti en CAD au taux du débit
// (montant débité ÷ total de la facture), montant par montant — le même calcul
// que le bouton « Conversion de devise ». Jamais de ligne « Frais de
// conversion » (demande de Charles, 2026-09-27).
//
// « Fournisseur en CAD » se lit sur l'historique : ses factures déjà publiées
// l'ont été en CAD. Un fournisseur publié en USD (AWS) n'est pas touché — lui
// garde la convention « Frais de conversion ».
import db from '../db/database.js'
import { round2 } from '../utils/money.js'
import { canonicalVendorName } from './vendorIdentity.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

function vendorBookedInCad(company) {
  const name = canonicalVendorName(company || '').trim().toLowerCase()
  if (!name) return false
  const first = name.split(/[\s,]+/)[0]
  const rows = db.prepare(`
    SELECT company, currency FROM sale_receipts
    WHERE deleted_at IS NULL AND quickbooks_id IS NOT NULL AND quickbooks_id != ''
      AND LOWER(company) LIKE ? ORDER BY receipt_date DESC LIMIT 20
  `).all(`${first}%`)
  const same = rows.filter((r) => canonicalVendorName(r.company || '').trim().toLowerCase().split(/[\s,]+/)[0] === first)
  return same.length > 0 && (same[0].currency || 'CAD').toUpperCase() === 'CAD'
}

/** Convertit le reçu si les conditions sont réunies. @returns {boolean} converti */
export function autoConvertUsdReceipt(receiptId) {
  const rec = db.prepare(`
    SELECT id, company, currency, subtotal, tps, tvq, other_taxes, total, items, quickbooks_id, fx_converted_to
    FROM sale_receipts WHERE id=? AND deleted_at IS NULL
  `).get(String(receiptId))
  if (!rec || rec.quickbooks_id || rec.fx_converted_to) return false
  if ((rec.currency || '').toUpperCase() !== 'USD' || !(Number(rec.total) > 0)) return false
  const txn = db.prepare(`
    SELECT t.amount FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.matched_type='receipt' AND t.matched_id=? AND t.deleted_at IS NULL
      AND UPPER(COALESCE(a.currency, 'CAD')) = 'CAD'
    ORDER BY t.txn_date DESC LIMIT 1
  `).get(rec.id)
  const charged = round2(Math.abs(Number(txn?.amount) || 0))
  if (!charged) return false
  const rate = charged / Number(rec.total)
  // Garde-fou : un débit sans rapport avec la facture n'est pas un taux.
  if (rate < 1.1 || rate > 1.7) return false
  if (!vendorBookedInCad(rec.company)) return false

  const tps = round2((Number(rec.tps) || 0) * rate)
  const tvq = round2((Number(rec.tvq) || 0) * rate)
  const other = round2((Number(rec.other_taxes) || 0) * rate)
  // Résidu d'arrondi sur le sous-total, jamais sur les taxes.
  const subtotal = round2(charged - tps - tvq - other)

  let items = []
  try { items = JSON.parse(rec.items || '[]') } catch { items = [] }
  const priced = items.some((it) => it && it.total != null)
  if (priced) {
    items = items.map((it) => (it && it.total != null
      ? { ...it, total: round2(Number(it.total) * rate), ...(it.unit_price != null ? { unit_price: round2(Number(it.unit_price) * rate) } : {}) }
      : it))
    const sum = round2(items.reduce((s, it) => s + (it && it.total != null ? it.total : 0), 0))
    const residual = round2(subtotal - sum)
    if (residual !== 0) {
      let big = -1
      items.forEach((it, i) => { if (it && it.total != null && (big < 0 || it.total > items[big].total)) big = i })
      if (big >= 0) items[big] = { ...items[big], total: round2(items[big].total + residual) }
    }
  }

  db.prepare(`
    UPDATE sale_receipts
    SET currency='CAD', fx_converted_to='CAD', fx_converted_from='USD', fx_rate=?, fx_converted_at=${NOW},
        subtotal=?, tps=?, tvq=?, other_taxes=?, total=?, items=?, bank_charged_total=NULL, updated_at=${NOW}
    WHERE id=? AND quickbooks_id IS NULL AND fx_converted_to IS NULL
  `).run(Math.round(rate * 1e6) / 1e6, subtotal, tps, tvq, other, charged,
    priced ? JSON.stringify(items) : rec.items, rec.id)
  return true
}
