// Abonnements fournisseurs (SaaS et charges récurrentes).
//
// Le registre ERP (page Abonnements fournisseurs) est LA référence — l'ancien
// onglet Abonnements du Google Sheets « CTB - Suivi » a été abandonné.
//
// Deux responsabilités :
// 1. Calcul des charges attendues (dates prévues selon fréquence + jour de
//    facturation) — sert au croisement avec les reçus ingérés.
// 2. Croisement « charge attendue ↔ reçu » : une charge dont aucun reçu du
//    fournisseur n'existe dans la fenêtre = reçu manquant à réclamer.
import db from '../db/database.js'
import { normalizeVendorKey } from './vendorDirectory.js'

// ── Charges attendues ────────────────────────────────────────────────────────

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Jour de facturation borné à la fin du mois (31 → 28/29/30 selon le mois).
function chargeDateFor(year, monthIdx0, day) {
  const lastDay = new Date(year, monthIdx0 + 1, 0).getDate()
  return new Date(year, monthIdx0, Math.min(day, lastDay), 12)
}

// Dates de charge attendues (ISO YYYY-MM-DD, plus récente d'abord) pour un
// abonnement, jusqu'à aujourd'hui inclus.
// - Mensuel + billing_day : une date par mois sur `lookbackMonths` mois.
// - Annuel + billing_month/billing_day : la dernière occurrence passée.
// - Infos de facturation absentes → [] (non vérifiable).
export function computeExpectedCharges(sub, { today = new Date(), lookbackMonths = 2 } = {}) {
  const day = Number(sub.billing_day)
  if (!Number.isInteger(day) || day < 1 || day > 31) return []
  const out = []
  if (sub.frequency === 'Mensuel') {
    for (let i = 0; i <= lookbackMonths; i++) {
      const d = chargeDateFor(today.getFullYear(), today.getMonth() - i, day)
      if (d <= today) out.push(isoDate(d))
    }
    return out.slice(0, lookbackMonths)
  }
  if (sub.frequency === 'Annuel') {
    const month = Number(sub.billing_month)
    if (!Number.isInteger(month) || month < 1 || month > 12) return []
    let d = chargeDateFor(today.getFullYear(), month - 1, day)
    if (d > today) d = chargeDateFor(today.getFullYear() - 1, month - 1, day)
    return [isoDate(d)]
  }
  return []
}

// Deux clés fournisseur matchent si identiques, ou si l'une contient l'autre
// (≥ 4 caractères) — « OpenAI » ↔ « Open AI », « Linode » ↔ « Linode Akamai ».
export function vendorKeysMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 4 && b.includes(a)) return true
  if (b.length >= 4 && a.includes(b)) return true
  return false
}

// Croisement charges attendues ↔ reçus ingérés. Une charge est « manquante »
// si sa date attendue est passée d'au moins `graceDays` et qu'aucun reçu du
// fournisseur n'existe dans [attendue − windowBefore, attendue + windowAfter].
// `receipts` = [{company, receipt_date}] ; injectable pour les tests.
export function crossCheckReceipts(subs, receipts, {
  today = new Date(), graceDays = 5, windowBefore = 10, windowAfter = 30, lookbackMonths = 2,
} = {}) {
  const byKey = []
  for (const r of receipts) {
    if (!r.company || !r.receipt_date) continue
    byKey.push({ key: normalizeVendorKey(r.company), date: String(r.receipt_date).slice(0, 10) })
  }
  const cutoff = new Date(today)
  cutoff.setDate(cutoff.getDate() - graceDays)
  const missing = []
  for (const sub of subs) {
    const subKey = normalizeVendorKey(sub.vendor)
    const mine = byKey.filter(r => vendorKeysMatch(subKey, r.key))
    const lastReceipt = mine.map(r => r.date).sort().pop() || null
    for (const expected of computeExpectedCharges(sub, { today, lookbackMonths })) {
      if (new Date(expected + 'T12:00:00') > cutoff) continue
      const from = new Date(expected + 'T12:00:00'); from.setDate(from.getDate() - windowBefore)
      const to = new Date(expected + 'T12:00:00'); to.setDate(to.getDate() + windowAfter)
      const found = mine.some(r => r.date >= isoDate(from) && r.date <= isoDate(to))
      if (!found) {
        missing.push({
          subscription_id: sub.id,
          vendor: sub.vendor,
          expected_date: expected,
          amount: sub.amount,
          amount_label: sub.amount_label,
          currency: sub.currency,
          frequency: sub.frequency,
          payment_method: sub.payment_method,
          last_receipt_date: lastReceipt,
        })
      }
    }
  }
  missing.sort((a, b) => (a.expected_date < b.expected_date ? 1 : -1))
  return missing
}

export function findMissingReceipts(options = {}) {
  const subs = db.prepare(`
    SELECT * FROM vendor_subscriptions
    WHERE deleted_at IS NULL AND active = 1
  `).all()
  // Reçus des 14 derniers mois (couvre le lookback annuel + fenêtres).
  const receipts = db.prepare(`
    SELECT company, receipt_date FROM sale_receipts
    WHERE deleted_at IS NULL AND company IS NOT NULL AND receipt_date IS NOT NULL
      AND receipt_date >= strftime('%Y-%m-%d', 'now', '-14 months')
  `).all()
  return crossCheckReceipts(subs, receipts, options)
}

