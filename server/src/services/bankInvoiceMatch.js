// ── Retrouver LA facture qu'un virement encaisse ────────────────────────────
// Un virement client entre au compte sans document. Le montant seul ne suffit
// pas à désigner la facture : plusieurs factures ouvertes portent souvent le
// même total (demande de Charles, 2026-09-19). Deux autres témoins existent au
// relevé : le nom du payeur (« BIOTALENT CANAD », « Interac e-Transfer from
// /Venn Software / », « AU POTAGER DU PAYSAN ») et la date. Chaque candidate
// repart d'ici avec sa note et ses raisons en clair, et on ne déclare « sûre »
// qu'une candidate nettement détachée de la suivante — sinon la page demande
// de choisir plutôt que de deviner.
import db from '../db/database.js'
import { usdCadRateLookup } from './fx.js'

// Les primitives de texte et de dates vivent dans textMatch.js : les deux sens
// du rapprochement (encaissement ici, dépense dans bankReceiptMatch.js) doivent
// juger un libellé de la même façon. On les ré-exporte, elles font partie du
// contrat de ce module depuis ses premiers appelants.
import {
  AMOUNT_EPS, normalizeText, nameTokens, nameMatch, bankText, daysBetween, round2,
} from './textMatch.js'

export { normalizeText, nameTokens, nameMatch, bankText }

// Note d'une facture face à une ligne de relevé, avec la liste des raisons
// affichées telles quelles dans la page.
export function scoreInvoice(txn, f, { amountCad, rate, text }) {
  const reasons = []
  let score = 0

  const due = Number(f.balance_due ?? f.total_amount) || 0
  const total = Number(f.total_amount) || 0
  const native = Number(txn.amount) || 0
  const sameCurrency = (f.currency || 'CAD').toUpperCase() === (txn.account_currency || 'CAD').toUpperCase()
  const converted = sameCurrency ? native : (rate ? round2(amountCad / rate) : null)
  const seen = sameCurrency ? native : converted

  if (seen != null && Math.abs(due - seen) <= AMOUNT_EPS) {
    score += sameCurrency ? 50 : 40
    reasons.push(sameCurrency ? 'montant exact' : `montant exact une fois converti (≈ ${rate})`)
  } else if (seen != null && Math.abs(total - seen) <= AMOUNT_EPS) {
    score += 30
    reasons.push('total de la facture')
  } else if (seen != null && due > 0 && Math.abs(due - seen) <= Math.max(1, due * 0.01)) {
    score += 18
    reasons.push(`écart de ${round2(Math.abs(due - seen))} $`)
  } else if (seen != null && due > 0 && seen > due) {
    reasons.push('le virement couvre plus que cette facture')
  } else {
    reasons.push('montant différent')
  }

  const nm = nameMatch(f.company_name, text)
  if (nm.ratio >= 0.5 || nm.hits >= 2) {
    score += 45
    reasons.push('nom du payeur au relevé')
  } else if (nm.hits >= 1) {
    score += 22
    reasons.push('nom du payeur proche')
  }

  // Le numéro de la facture écrit dans la référence du virement : preuve rare
  // mais décisive.
  const num = normalizeText(f.document_number).replace(/ /g, '')
  if (num.length >= 5 && normalizeText(text).replace(/ /g, '').includes(num)) {
    score += 40
    reasons.push('numéro de facture au relevé')
  }

  const gap = daysBetween(f.document_date, txn.txn_date)
  if (gap != null && gap < -3) {
    score -= 25
    reasons.push('facture postérieure au dépôt')
  } else if (gap != null && gap <= 45) {
    score += 12
  } else if (gap != null && gap <= 120) {
    score += 6
  }

  if (f.out_of_band) reasons.push('marquée payée dans Stripe sans encaissement')

  return { score, reasons }
}

// Les factures qu'on accepte de proposer : celles qui restent dues, plus
// celles que Stripe a marquées payées sans encaissement réel et qui n'ont
// aucun paiement saisi ici — ce sont justement celles qu'un virement solde.
function openInvoices() {
  return db.prepare(`
    SELECT f.id, f.document_number, f.total_amount, f.balance_due, f.currency,
           f.document_date, f.lien_stripe, f.invoice_id, f.paid_at,
           f.paid_charge_id, f.paid_payment_intent, f.airtable_pdf_path,
           c.name AS company_name,
           CASE WHEN COALESCE(f.balance_due, 0) > 0 THEN 0 ELSE 1 END AS out_of_band
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE COALESCE(f.balance_due, 0) > 0
       OR (f.paid_at IS NOT NULL
           AND f.paid_charge_id IS NULL AND f.paid_payment_intent IS NULL
           AND COALESCE(f.total_amount, 0) > 0
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.facture_id = f.id AND p.direction='in'))
  `).all()
}

// Candidates triées, chacune avec sa note, ses raisons et son verdict.
// `q` : recherche libre de l'humain quand la détection n'a pas trouvé — le
// filtre remplace alors le seuil de note, rien n'est écarté en silence.
export function findInvoiceCandidates(txn, account, { q = null, limit = 6 } = {}) {
  const text = bankText(txn)
  const currency = (account?.currency || 'CAD').toUpperCase()
  const rateFor = usdCadRateLookup()
  const rate = currency === 'CAD' ? (rateFor(txn.txn_date) || null) : null
  const amountCad = currency === 'CAD' ? Number(txn.amount) : null
  const needle = q ? normalizeText(q) : null

  let rows = openInvoices()
  if (needle) {
    rows = rows.filter(f => normalizeText(`${f.company_name || ''} ${f.document_number || ''}`).includes(needle))
  }

  const scored = rows.map((f) => {
    const { score, reasons } = scoreInvoice({ ...txn, account_currency: currency }, f, { amountCad, rate, text })
    return { ...f, out_of_band: !!f.out_of_band, score, reasons }
  // À note égale (même client, même montant : le cas des abonnements), la plus
  // ancienne d'abord — c'est celle qu'un client règle en premier.
  }).sort((a, b) => b.score - a.score || String(a.document_date || '').localeCompare(String(b.document_date || '')))

  const kept = (needle ? scored : scored.filter(c => c.score >= 40)).slice(0, limit)
  if (!kept.length) return { candidates: [], ambiguous: false }

  const lead = kept.length > 1 ? kept[0].score - kept[1].score : 999
  kept.forEach((c, i) => {
    c.verdict = i === 0 && c.score >= 85 && lead >= 25 ? 'sure'
      : c.score >= 55 ? 'probable' : 'faible'
  })
  return { candidates: kept, ambiguous: kept.length > 1 && lead < 25 }
}
