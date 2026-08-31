import db from '../../db/database.js'
import { refreshStatuses } from '../bankReconciliation.js'
import { amountMatches } from './invoiceNeeds.js'
import { nowIso } from '../../utils/datetime.js'

// Boucler la boucle : une fois la facture ingérée et extraite, l'attacher à la
// transaction bancaire qui l'attendait. C'est ce qui fait passer la ligne de
// « à traiter » à « facture reçue » — deriveStatus() s'en charge dès que
// matched_id est posé, il n'y a pas de statut à écrire à la main.

const sleep = ms => new Promise(r => setTimeout(r, ms))

// L'extraction tourne en tâche de fond (~4,5 s en moyenne, jusqu'à ~18 s sur une
// facture de transport multipage). On l'attend avant de comparer les montants :
// le total extrait du PDF fait foi, pas celui annoncé par le portail.
export async function awaitExtraction(receiptId, { timeoutMs = 60_000, stepMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = db.prepare('SELECT id, status, total, currency, receipt_date, company FROM sale_receipts WHERE id=?').get(receiptId)
    if (!row) return null
    if (row.status === 'done' || row.status === 'error') return row
    if (Date.now() >= deadline) return row
    await sleep(stepMs)
  }
}

/**
 * Attache un reçu à une transaction bancaire, si et seulement si le montant
 * extrait du PDF concorde vraiment.
 * @returns {{ok:true}|{ok:false, reason:string, note:string}}
 */
export function linkReceiptToTransaction({ need, receipt }) {
  if (!receipt || receipt.status !== 'done') {
    return { ok: false, reason: 'ambigue', note: `extraction ${receipt?.status || 'absente'} — non liée` }
  }
  const txn = db.prepare('SELECT id, account_id, matched_id FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(need.bank_txn_id)
  if (!txn) return { ok: false, reason: 'ambigue', note: 'transaction disparue' }
  // Une décision humaine ne se défait jamais automatiquement.
  if (txn.matched_id) return { ok: false, reason: 'trouvee', note: 'transaction déjà liée à un autre document' }

  const check = amountMatches(need, { amount: receipt.total, currency: receipt.currency })
  if (!check.ok) {
    return {
      ok: false,
      reason: 'ambigue',
      note: `facture à ${Number(receipt.total).toFixed(2)} ${receipt.currency || ''} vs ${Math.abs(need.amount).toFixed(2)} au relevé — ${check.reason}`.trim(),
    }
  }

  db.prepare(`
    UPDATE bank_transactions
    SET matched_type='receipt', matched_id=?, match_method='auto', match_confidence=?, updated_at=?
    WHERE id=?
  `).run(receipt.id, check.exact ? 0.95 : 0.85, nowIso(), txn.id)
  // deriveStatus lit matched_id : la ligne devient « facture reçue » d'elle-même.
  try { refreshStatuses(txn.account_id) } catch { /* recalcul best-effort, refait à chaque lecture */ }
  return { ok: true, exact: check.exact, delta: check.delta, accountId: txn.account_id }
}
