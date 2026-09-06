// Rattacher au relevé bancaire les sorties d'argent que l'ERP connaît déjà.
//
// Deux états qu'on confondait faute de voir la banque : « l'écriture existe
// dans QuickBooks » et « l'argent est sorti du compte ». Le second se
// vérifiait à l'œil sur le relevé. Maintenant que la banque est branchée, ce
// passage fait le lien tout seul, à chaque arrivée de transactions :
//
//   - paie : le débit Nethris de la quinzaine → la paie qui l'attend, qui
//     devient « prête à publier » (aucune écriture n'est publiée toute seule) ;
//   - dettes à long terme : le prélèvement mensuel → le versement de la cédule,
//     qui affiche « passé à la banque ».
//
// Rien n'est deviné : sans libellé configuré, sans candidat unique ou sur un
// montant qui s'écarte trop de l'attendu, on ne rattache pas — la ligne reste
// à traiter, visible, plutôt que silencieusement mal appariée.
import db from '../db/database.js'
import { findBankDebit, shiftDate } from './bankDebitLookup.js'
import { round2 } from '../utils/money.js'

export const BANK_DEBIT_LINK_AUTOMATION_ID = 'sys_bank_debit_link'

// Fenêtre de recherche d'un versement de dette autour de sa date prévue, et
// écart de montant toléré : le BDC varie d'un mois à l'autre (8 658 → 9 019 $)
// parce que la part d'intérêts bouge, mais jamais de 2 %.
const DEBT_DAY_WINDOW = 5
const DEBT_TOLERANCE_PCT = 2

// Nom du compte ERP correspondant au compte de banque QuickBooks d'une dette.
// La dette porte un NUMÉRO de compte QB (10000) ; les comptes du rapprochement
// portent l'ID interne QB (61) — parfois plusieurs, séparés par des virgules
// (BNC USD est suivi sous deux comptes). Le cache de comptes QuickBooks fait
// le pont ; sans QuickBooks joignable, on ne rattache rien plutôt que de
// deviner le compte.
async function bankAccountNameForAcctnum(acctnum) {
  if (!acctnum) return null
  const { resolveAccountByAcctNum } = await import('./quickbooks.js')
  const qbId = await resolveAccountByAcctNum(acctnum)
  if (!qbId) return null
  const rows = db.prepare('SELECT name, qb_account_id FROM bank_accounts WHERE qb_account_id IS NOT NULL AND deleted_at IS NULL').all()
  const hit = rows.find(r => String(r.qb_account_id).split(',').map(x => x.trim()).includes(String(qbId)))
  return hit?.name || null
}

// Frais annuels attendus SUR ce versement précis. Le prêteur les ajoute au
// débit sans les inscrire à la cédule : sans cette règle, le montant vu au
// compte dépasse l'attendu et le versement passe pour introuvable (c'est ce
// qui est arrivé au versement BDC du 23 août 2026, 350 $ de plus).
export function expectedFeeFor(debt, paymentDate) {
  const fee = Number(debt.annual_fee_amount) || 0
  const month = Number(debt.annual_fee_month) || 0
  if (!(fee > 0) || !month) return 0
  return Number(String(paymentDate).slice(5, 7)) === month ? round2(fee) : 0
}

export async function confirmDebtPaymentsFromBank(debtId = null) {
  const debts = debtId
    ? db.prepare('SELECT * FROM lt_debts WHERE id=? AND deleted_at IS NULL').all(debtId)
    : db.prepare('SELECT * FROM lt_debts WHERE deleted_at IS NULL AND active=1').all()
  const linked = []
  for (const debt of debts) {
    if (!debt.bank_label_pattern) continue
    const accountName = await bankAccountNameForAcctnum(debt.qb_bank_acctnum)
    if (!accountName) continue
    const payments = db.prepare(`
      SELECT id, payment_date, principal, interest FROM lt_debt_payments
      WHERE debt_id=? AND deleted_at IS NULL AND bank_txn_id IS NULL
        AND payment_date <= date('now') AND payment_date >= date('now','-120 days')
      ORDER BY payment_date
    `).all(debt.id)
    if (!payments.length) continue
    const used = db.prepare('SELECT bank_txn_id FROM lt_debt_payments WHERE bank_txn_id IS NOT NULL AND deleted_at IS NULL')
      .all().map(r => r.bank_txn_id)
    for (const p of payments) {
      const scheduled = round2((Number(p.principal) || 0) + (Number(p.interest) || 0))
      if (!(scheduled > 0)) continue
      // Le mois des frais annuels, c'est le débit AVEC les frais qu'on attend.
      const fee = expectedFeeFor(debt, p.payment_date)
      const expected = round2(scheduled + fee)
      const found = findBankDebit({
        accountName,
        pattern: debt.bank_label_pattern,
        from: shiftDate(p.payment_date, -DEBT_DAY_WINDOW),
        to: shiftDate(p.payment_date, DEBT_DAY_WINDOW),
        amountHint: expected,
        tolerancePct: DEBT_TOLERANCE_PCT,
        excludeTxnIds: used,
      })
      const hit = found.match && !found.match.pending
        && found.match.delta_pct != null && found.match.delta_pct <= DEBT_TOLERANCE_PCT
        ? found.match : null
      if (!hit) continue
      // Ce que la banque a pris en plus de la cédule : les frais quand ils
      // expliquent l'écart, sinon un reste à comprendre. Écrit dans les deux
      // cas — un écart inexpliqué doit rester visible.
      const extra = round2(hit.amount - scheduled)
      db.prepare(`UPDATE lt_debt_payments SET bank_txn_id=?, bank_extra_amount=?,
                  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(hit.id, Math.abs(extra) < 0.005 ? null : extra, p.id)
      used.push(hit.id)
      linked.push({ debt: debt.label, payment_id: p.id, payment_date: p.payment_date,
        txn_id: hit.id, amount: hit.amount, extra: extra || null, expected_fee: fee || null })
    }
  }
  return linked
}

// Passage complet, déclenché à chaque arrivée de transactions bancaires et
// disponible à la main depuis la fiche de l'automation. Un domaine en échec
// (QuickBooks injoignable pour les dettes, par exemple) n'empêche pas l'autre.
export async function linkKnownDebits() {
  const out = { paies: [], debts: [] }
  try {
    const { linkPaiesToBankDebits } = await import('./paieSalaryExpense.js')
    out.paies = linkPaiesToBankDebits()
  } catch (e) {
    out.paies_error = e.message
  }
  try {
    out.debts = await confirmDebtPaymentsFromBank()
  } catch (e) {
    out.debts_error = e.message
  }
  return out
}

export function summarizeLinks(out) {
  const parts = []
  if (out.paies?.length) parts.push(`${out.paies.length} paie(s) rattachée(s) à leur débit`)
  if (out.debts?.length) parts.push(`${out.debts.length} versement(s) de dette vu(s) au relevé`)
  if (out.paies_error) parts.push(`paies : échec (${out.paies_error})`)
  if (out.debts_error) parts.push(`dettes : échec (${out.debts_error})`)
  return parts.join(' · ') || 'rien de nouveau à rattacher'
}
