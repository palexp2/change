// Ce que fait le clic. Une proposition acceptée appelle la fonction qui aurait
// été appelée de toute façon — jamais une route HTTP interne, jamais un SQL
// parallèle : l'état comptable n'a qu'un seul chemin d'écriture par domaine.
//
// Protocole, dans cet ordre :
//   1. réservation atomique du statut (deux clics simultanés → 409) ;
//   2. application ;
//   3. péremption des propositions devenues sans objet sur la même ligne ;
//   4. en cas d'échec, retour à « proposée » avec le message — rien n'est perdu.
import db from '../../db/database.js'
import { refreshStatuses } from '../bankReconciliation.js'
import { decode } from './store.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

export class ProposalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Un lien QuickBooks confirmé porte `qb_match_method='proposition'` : c'est ce
// qui empêche l'audit suivant de l'effacer (voir clearStaleLinks).
function applyQbLink(p) {
  const { qb_txn_id: qbId, qb_txn_type: entity, method, delta, account_name: accountName, rate } = p.payload || {}
  if (!qbId) throw new ProposalError('Proposition sans écriture QuickBooks')
  const res = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=?, qb_txn_id=?, qb_match_method='proposition', qb_match_delta=?,
        qb_match_account=?, qb_match_rate=?,
        status=CASE WHEN status IN ('a_traiter','facture_recue') THEN 'comptabilise' ELSE status END,
        updated_at=${NOW}
    WHERE id=? AND deleted_at IS NULL
  `).run(entity || null, String(qbId), delta ?? null,
    method === 'autre_compte' ? (accountName || null) : null, rate || null, p.bank_txn_id)
  if (!res.changes) throw new ProposalError('Transaction introuvable', 404)
  return { qb_txn_id: String(qbId), qb_txn_type: entity || null }
}

// Cocher « passé à la banque » : exactement ce que fait le bouton de la page
// Paiements émis, avec la trace que c'est une proposition acceptée.
async function applyPaymentClear(p) {
  const { setCleared } = await import('../treasuryPayments.js')
  const id = p.payload?.payment_id
  if (!id) throw new ProposalError('Proposition sans paiement')
  setCleared(id, true, { bankTxnId: p.bank_txn_id, source: 'proposition' })
  return { payment_id: id }
}

// Rattacher la paie à son débit. Ne publie RIEN : la dépense de paie reste un
// second geste, sur la page Comptabilité.
async function applyPaieDebit(p) {
  const { attachPaieBankDebit } = await import('../paieSalaryExpense.js')
  const id = p.payload?.paie_id
  if (!id) throw new ProposalError('Proposition sans paie')
  attachPaieBankDebit(id, p.bank_txn_id)
  return { paie_id: id }
}

async function applyDebtPayment(p) {
  const { attachDebtPaymentBankTxn } = await import('../bankDebitLink.js')
  const id = p.payload?.payment_id
  if (!id) throw new ProposalError('Proposition sans versement')
  if (!attachDebtPaymentBankTxn(id, p.bank_txn_id, p.payload?.extra ?? null)) {
    throw new ProposalError('Versement introuvable', 404)
  }
  return { lt_debt_payment_id: id }
}

// Rattacher le document que l'ERP possédait déjà. N'écrit rien dans
// QuickBooks : la ligne passe « facture reçue », la publication reste un geste.
function applyDocMatch(p) {
  const { matched_type: type, matched_id: id, confidence } = p.payload || {}
  if (!type || !id) throw new ProposalError('Proposition sans document')
  const res = db.prepare(`
    UPDATE bank_transactions
    SET matched_type=?, matched_id=?, match_method='manuel', match_confidence=?,
        status=CASE WHEN status='a_traiter' THEN 'facture_recue' ELSE status END,
        updated_at=${NOW}
    WHERE id=? AND matched_id IS NULL AND deleted_at IS NULL
  `).run(type, String(id), confidence ?? 1, p.bank_txn_id)
  // La garde `matched_id IS NULL` rejoue la validation au moment d'écrire :
  // la ligne a pu être appariée à la main entre-temps.
  if (!res.changes) throw new ProposalError('Cette ligne vient d\'être liée ailleurs', 409)
  return { matched_type: type, matched_id: String(id) }
}

// Le prélèvement d'assurance collective, ventilé au prorata dans les comptes de
// salaires. PUBLIE dans QuickBooks — c'est le clic qui l'autorise, et la clé de
// période empêche qu'un mois parte deux fois.
async function applyAgaRepartition(p) {
  const { pushAgaRepartition } = await import('../paieRepartition.js')
  const { amount, txn_date: txnDate } = p.payload || {}
  if (!amount) throw new ProposalError('Proposition sans montant')
  const res = await pushAgaRepartition(amount, txnDate, { bankTxnId: p.bank_txn_id })
  return { quickbooks_id: res?.quickbooks_id || res?.id || null, amount }
}

// La dépense sans pièce, créée depuis le dossier de préparation puis publiée.
// PUBLIE dans QuickBooks. Un échec côté Intuit laisse l'achat et le lien en
// place : la proposition retombe en « proposée » avec le message, et la
// publication reste rejouable depuis la fiche de l'achat.
async function applyVendorExpense(p) {
  const { addExpenseFromTxn } = await import('../bankActions.js')
  const txn = db.prepare('SELECT * FROM bank_transactions WHERE id=? AND deleted_at IS NULL').get(p.bank_txn_id)
  if (!txn) throw new ProposalError('Transaction introuvable', 404)
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(txn.account_id)
  const { achatId } = addExpenseFromTxn(txn, account, p.payload || {}, p.decided_by || null)

  const { pushAchatToQB } = await import('../quickbooks.js')
  const quickbooksId = await pushAchatToQB(achatId)
  return { achat_id: achatId, quickbooks_id: quickbooksId }
}

const APPLIERS = {
  qb_link: applyQbLink,
  payment_clear: applyPaymentClear,
  paie_debit: applyPaieDebit,
  debt_payment: applyDebtPayment,
  doc_match: applyDocMatch,
  aga_repartition: applyAgaRepartition,
  vendor_expense: applyVendorExpense,
}

// Les natures dont l'acceptation écrit dans QuickBooks. Aucune n'est jamais
// appliquée sans geste humain — c'est l'invariant du moteur.
export const PUBLISHES_TO_QB = new Set(['aga_repartition', 'vendor_expense'])

export function getProposal(id) {
  return decode(db.prepare('SELECT * FROM bank_proposals WHERE id=?').get(id))
}

export async function acceptProposal(id, userId) {
  const p = getProposal(id)
  if (!p) throw new ProposalError('Proposition introuvable', 404)
  const applier = APPLIERS[p.kind]
  if (!applier) throw new ProposalError(`Nature « ${p.kind} » pas encore applicable`, 501)

  // Réservation : le premier clic gagne, le second reçoit un 409.
  const taken = db.prepare(`
    UPDATE bank_proposals SET status='acceptee', decided_at=${NOW}, decided_by=?, last_error=NULL, updated_at=${NOW}
    WHERE id=? AND status='proposee'
  `).run(userId || null, id)
  if (!taken.changes) throw new ProposalError('Cette proposition a déjà été tranchée', 409)

  try {
    const result = await applier(p)
    db.prepare(`UPDATE bank_proposals SET applied_result=?, updated_at=${NOW} WHERE id=?`)
      .run(JSON.stringify(result || {}), id)
    // Les autres propositions ouvertes sur la même ligne n'ont plus d'objet.
    db.prepare(`
      UPDATE bank_proposals SET status='perimee', decision_note='la ligne a été traitée autrement', updated_at=${NOW}
      WHERE bank_txn_id=? AND id!=? AND status='proposee'
    `).run(p.bank_txn_id, id)
    refreshStatuses(accountOf(p.bank_txn_id))
    return { ...getProposal(id), result }
  } catch (e) {
    db.prepare(`UPDATE bank_proposals SET status='proposee', decided_at=NULL, decided_by=NULL, last_error=?, updated_at=${NOW} WHERE id=?`)
      .run(e.message, id)
    throw e
  }
}

// Refuser n'écrit RIEN côté comptable : la proposition devient le « non », et
// c'est ce non qui empêche le moteur de la reproposer au prochain passage.
export function refuseProposal(id, userId, note = null) {
  const p = getProposal(id)
  if (!p) throw new ProposalError('Proposition introuvable', 404)
  const res = db.prepare(`
    UPDATE bank_proposals SET status='refusee', decided_at=${NOW}, decided_by=?, decision_note=?, updated_at=${NOW}
    WHERE id=? AND status='proposee'
  `).run(userId || null, note, id)
  if (!res.changes) throw new ProposalError('Cette proposition a déjà été tranchée', 409)
  return getProposal(id)
}

function accountOf(txnId) {
  return db.prepare('SELECT account_id FROM bank_transactions WHERE id=?').get(txnId)?.account_id
}
