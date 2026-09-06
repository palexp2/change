// Retrouver, dans le relevé bancaire, LE mouvement qui correspond à une sortie
// que l'ERP connaît déjà : le débit de la paie, le prélèvement de l'assurance
// collective, le versement d'une dette. Toutes ces comptabilisations
// demandaient jusqu'ici d'ouvrir le relevé et de recopier le montant à la
// main ; depuis que la banque est branchée (Plaid), le mouvement est là.
//
// Le principe est le même partout : un libellé reconnaissable, une fenêtre de
// dates autour de l'échéance attendue, et un montant approximatif qui sert
// d'arbitre quand plusieurs mouvements collent. On ne devine JAMAIS : si deux
// candidats restent en lice, on les rend tous les deux et c'est l'humain qui
// tranche.
import db from './../db/database.js'
import { normalizeLabel } from './bankReconciliation.js'

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Le motif est écrit par l'utilisateur dans la config d'une automation
// (« NETHRIS PAIE », « AGA », « VILLE DE QUEBEC ») : on le compare token par
// token sur le libellé normalisé (sans accents ni ponctuation), comme
// labelMatchesVendor. Un motif vide ne matche rien — jamais tout.
export function labelMatchesPattern(label, pattern) {
  const hay = normalizeLabel(label)
  const tokens = normalizeLabel(pattern).split(' ').filter(Boolean)
  if (!hay || !tokens.length) return false
  return tokens.every(t => hay.includes(t))
}

const round2 = n => Math.round(n * 100) / 100

/**
 * Cherche un débit (ou un crédit si `direction: 'in'`) au relevé.
 *
 * @param {string} accountName    nom du compte ERP (« BNC CAD »)
 * @param {string} pattern        libellé attendu (« NETHRIS PAIE »)
 * @param {string} from,to        fenêtre de dates incluse (YYYY-MM-DD)
 * @param {number} [amountHint]   montant attendu, en valeur absolue
 * @param {number} [tolerancePct] écart toléré autour de l'indice (défaut 15 %)
 * @param {string[]} [excludeTxnIds] transactions déjà rattachées ailleurs
 * @param {boolean} [excludeBooked] écarter celles déjà liées à une écriture QB
 * @returns {{match, candidates, stale_since, account_id}}
 *   `match` = le mouvement retenu (null si aucun ou si le choix est ambigu),
 *   `candidates` = tous ceux qui collent (vide si aucun),
 *   `stale_since` = date du dernier mouvement connu sur le compte, pour dire
 *   « rien vu depuis le … » plutôt que « rien » quand la banque est muette.
 */
export function findBankDebit({
  accountName, pattern, from, to, amountHint = null, tolerancePct = 15,
  excludeTxnIds = [], excludeBooked = false, direction = 'out',
} = {}) {
  const account = db.prepare('SELECT id, name FROM bank_accounts WHERE name=? AND deleted_at IS NULL').get(accountName)
  if (!account) return { match: null, candidates: [], stale_since: null, account_id: null }

  const staleRow = db.prepare(
    'SELECT MAX(txn_date) AS d FROM bank_transactions WHERE account_id=? AND deleted_at IS NULL'
  ).get(account.id)

  const rows = db.prepare(`
    SELECT id, txn_date, amount, description, details, pending, qb_txn_id, qb_txn_type, status
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
      AND txn_date >= ? AND txn_date <= ?
      AND ${direction === 'in' ? 'amount > 0' : 'amount < 0'}
    ORDER BY txn_date, created_at
  `).all(account.id, from, to)

  const excluded = new Set(excludeTxnIds.filter(Boolean))
  let candidates = rows
    .filter(r => !excluded.has(r.id))
    .filter(r => !(excludeBooked && r.qb_txn_id))
    .filter(r => labelMatchesPattern(`${r.details || ''} ${r.description || ''}`, pattern))
    .map(r => ({
      id: r.id,
      txn_date: r.txn_date,
      amount: round2(Math.abs(r.amount)),
      label: r.details || r.description || '',
      pending: !!r.pending,
      qb_txn_id: r.qb_txn_id || null,
      delta_pct: amountHint > 0 ? round2(Math.abs(Math.abs(r.amount) - amountHint) / amountHint * 100) : null,
    }))

  let match = null
  if (candidates.length === 1) {
    match = candidates[0]
  } else if (candidates.length > 1 && amountHint > 0) {
    // Plusieurs mouvements portent le libellé : le montant attendu départage,
    // mais seulement s'il désigne UN candidat sans hésitation possible.
    const close = candidates.filter(c => c.delta_pct != null && c.delta_pct <= tolerancePct)
    if (close.length === 1) match = close[0]
  }
  return { match, candidates, stale_since: staleRow?.d || null, account_id: account.id }
}

// Rattache une transaction bancaire à l'écriture QuickBooks qui vient d'être
// publiée depuis l'ERP : la ligne passe « comptabilisée » au rapprochement
// tout de suite, sans attendre le passage d'audit QuickBooks (aux 20 min).
export function linkTxnToQbEntity(txnId, { qbTxnId, qbTxnType = 'purchase' } = {}) {
  if (!txnId || !qbTxnId) return false
  const res = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_id=?, qb_txn_type=?, qb_match_method='erp',
        status=CASE WHEN status IN ('a_traiter','facture_recue') THEN 'comptabilise' ELSE status END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND deleted_at IS NULL AND qb_txn_id IS NULL
  `).run(String(qbTxnId), qbTxnType, txnId)
  return res.changes > 0
}
