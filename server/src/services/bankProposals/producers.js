// Les producteurs « locaux » : ceux qui n'appellent aucune API et qui peuvent
// donc tourner à chaque arrivée de transactions, dans runPostImportHooks.
//
// Ils remplacent trois écritures silencieuses :
//   • un paiement émis se cochait « passé à la banque » tout seul ;
//   • une paie se rattachait toute seule à son débit ;
//   • un versement de dette aussi.
// Chacune était juste la plupart du temps — et invisible quand elle se
// trompait. Elles deviennent des propositions ; le geste explicite de
// l'utilisateur (bouton « apparier au relevé », fiche de dette), lui, continue
// d'écrire directement.
import db from '../../db/database.js'
import { evidenceFor, proposalFingerprint } from './model.js'
import { matchPaymentsToTxns } from '../treasuryPayments.js'
import { findPaieBankDebit } from '../paieSalaryExpense.js'
import { findDebtPaymentMatches } from '../bankDebitLink.js'

const round2 = (n) => Math.round(n * 100) / 100
const daysBetween = (a, b) => Math.round(Math.abs(new Date(a) - new Date(b)) / 86400000)

function finish(p) {
  p.fingerprint = proposalFingerprint(p)
  return p
}

// ── Paiements émis ──────────────────────────────────────────────────────────
export function producePaymentClears({ accountName = null, accountId = null } = {}) {
  return matchPaymentsToTxns({ accountName }).map(({ payment, txn }) => finish({
    kind: 'payment_clear',
    bank_txn_id: txn.id,
    account_id: txn.account_id || accountId,
    target_type: 'treasury_payment',
    target_id: payment.id,
    amount: txn.amount,
    confidence: exactish(txn.amount, payment.amount) ? 0.95 : 0.8,
    evidence: evidenceFor('payment_clear', {
      delta: round2(Math.abs(txn.amount) - Math.abs(payment.amount)),
      gap: daysBetween(txn.txn_date, payment.payment_date),
    }).concat([{ label: 'Paiement émis', detail: payment.label || payment.reference || '' }]),
    payload: {
      payment_id: payment.id,
      label: payment.label,
      payment_date: payment.payment_date,
      payment_amount: payment.amount,
      direction: payment.direction,
    },
    producer: 'treasuryPayments',
  }))
}

const exactish = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005

// ── Paie ────────────────────────────────────────────────────────────────────
// Rattacher n'est PAS publier : la dépense de paie reste un second geste, sur
// la page Comptabilité.
export function producePaieDebits() {
  const paies = db.prepare(`
    SELECT id, period_end FROM paies
    WHERE salary_purchase_id IS NULL AND bank_txn_id IS NULL
      AND period_end IS NOT NULL AND period_end <= date('now')
      AND period_end >= date('now', '-90 days')
    ORDER BY period_end
  `).all()
  const out = []
  for (const p of paies) {
    let found
    try { found = findPaieBankDebit(p.id) } catch { continue }
    const m = found?.match
    if (!m || m.pending) continue
    out.push(finish({
      kind: 'paie_debit',
      bank_txn_id: m.id,
      account_id: found.account_id || null,
      target_type: 'paie',
      target_id: String(p.id),
      period_key: `paie:${p.id}`,
      amount: m.amount,
      confidence: 0.9,
      evidence: [
        { label: 'Débit de paie reconnu au relevé' },
        { label: 'Période', detail: p.period_end },
      ],
      payload: { paie_id: p.id, period_end: p.period_end, amount: m.amount },
      producer: 'paieSalaryExpense',
    }))
  }
  return out
}

// ── Dettes long terme ───────────────────────────────────────────────────────
export async function produceDebtPayments() {
  const hits = await findDebtPaymentMatches()
  return hits.map((h) => finish({
    kind: 'debt_payment',
    bank_txn_id: h.txn_id,
    account_id: h.account_id || null,
    target_type: 'lt_debt_payment',
    target_id: String(h.payment_id),
    amount: h.amount,
    confidence: h.extra ? 0.85 : 0.95,
    evidence: [
      { label: 'Versement attendu', detail: h.debt },
      { label: 'Échéance', detail: h.payment_date },
      ...(h.extra ? [{ label: h.expected_fee ? 'Frais annuels inclus' : 'Montant en plus de la cédule', detail: `${h.extra.toFixed(2)} $` }] : []),
    ],
    payload: { payment_id: h.payment_id, debt: h.debt, extra: h.extra || null, expected_fee: h.expected_fee || null },
    producer: 'bankDebitLink',
  }))
}

// ── Documents que l'ERP possède déjà ────────────────────────────────────────
//
// `autoMatchAccount` attachait le document tout seul dès 0,8 de confiance. Le
// geste explicite (bouton « rapprocher automatiquement ») continue de le faire ;
// le passage automatique, lui, propose. Mêmes garde-fous qu'avant : seuil 0,8,
// refus à l'ex æquo (deuxième candidat à moins de 0,05), un document ne sert
// qu'une fois dans le passage.
export async function produceDocMatches(accountId, { minConfidence = 0.8, tieMargin = 0.05 } = {}) {
  // Import paresseux : bankReconciliation importe déjà ce module.
  const { findCandidates } = await import('../bankReconciliation.js')
  const txns = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND matched_id IS NULL
      AND transfer_txn_id IS NULL AND status='a_traiter' AND COALESCE(pending,0)=0
  `).all(accountId)

  const taken = new Set()
  const out = []
  for (const txn of txns) {
    const candidates = findCandidates(txn).filter((c) => !taken.has(`${c.type}:${c.id}`))
    const best = candidates[0]
    if (!best || best.confidence < minConfidence) continue
    if (candidates[1] && candidates[1].confidence >= best.confidence - tieMargin) continue
    taken.add(`${best.type}:${best.id}`)
    out.push(finish({
      kind: 'doc_match',
      bank_txn_id: txn.id,
      account_id: txn.account_id,
      target_type: best.type,
      target_id: String(best.id),
      amount: txn.amount,
      confidence: best.confidence,
      evidence: evidenceFor('doc_match', {
        vendor: best.label || best.vendor || null,
        delta: best.delta ?? null,
        gap: best.date ? daysBetween(txn.txn_date, best.date) : null,
      }),
      payload: { matched_type: best.type, matched_id: String(best.id), confidence: best.confidence },
    }))
  }
  return out
}

// ── Le prélèvement d'assurance collective (Groupe Financier AGA) ────────────
//
// Le seul producteur dont l'acceptation PUBLIE dans QuickBooks. C'est aussi le
// seul qui portait un vrai risque de doublon : la répartition n'avait aucune
// ancre côté ERP, rien n'empêchait de publier deux fois le prélèvement d'un
// mois. La clé de période (« aga:2026-09 ») et l'index d'unicité sur les
// propositions acceptées ferment cette porte.
export async function produceAgaRepartition() {
  const { findAgaBankDebit, computeAgaRepartition } = await import('../paieRepartition.js')
  let found
  try { found = findAgaBankDebit() } catch { return [] }
  const txn = found?.match
  if (!txn) return []

  let preview
  try { preview = computeAgaRepartition(Math.abs(txn.amount), txn.txn_date) } catch { return [] }
  // Une répartition qui ne sait pas où prendre l'argent n'est pas proposable.
  if (preview.warnings.length) return []

  return [finish({
    kind: 'aga_repartition',
    bank_txn_id: txn.id,
    account_id: txn.account_id,
    period_key: `aga:${String(txn.txn_date).slice(0, 7)}`,
    amount: txn.amount,
    confidence: 0.9,
    evidence: [
      { label: 'Assurance collective', detail: preview.vendor_name },
      { label: 'Répartie sur', detail: `${preview.shares.length} comptes de salaires` },
      { label: 'Prélèvement', detail: `${preview.amount.toFixed(2)} $` },
    ],
    payload: { amount: preview.amount, txn_date: txn.txn_date, shares: preview.shares },
  })]
}

// ── Dernier recours : la dépense sans pièce ─────────────────────────────────
//
// Quand aucune facture n'existe nulle part mais que le dossier de préparation
// est COMPLET — fournisseur reconnu et compte de dépense connu, qu'ils viennent
// d'une règle, du profil ou de l'habitude. Tout ce qui est incomplet reste à
// l'écran sans proposition : on ne demande pas un clic sur un formulaire à trous.
export async function produceVendorExpenses(accountId, { limit = 40 } = {}) {
  const { buildEntryDraft } = await import('../bankEntryDraft.js')
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) return []

  const txns = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND amount < 0
      AND matched_id IS NULL AND transfer_txn_id IS NULL AND qb_txn_id IS NULL
      AND status='a_traiter' AND COALESCE(pending,0)=0
    ORDER BY txn_date DESC LIMIT ?
  `).all(accountId, limit)

  const out = []
  for (const txn of txns) {
    const draft = buildEntryDraft(txn, account)
    if (!draft.ready) continue
    // Une règle qui exclut, vire ou répartit ne fait pas une dépense d'un seul
    // compte : elle se traite dans le panneau, pas par cette proposition.
    if (draft.rule && (draft.rule.action && draft.rule.action !== 'depense' || draft.rule.splits)) continue
    const f = draft.fields
    // Accepter cette proposition PUBLIE dans QuickBooks : une habitude
    // minoritaire (« 2 fois sur 4 ») ne suffit pas. Il faut une valeur
    // déclarée — règle ou profil — ou une habitude nettement majoritaire.
    if (!isSolidEnoughToPublish(f.expense_account_id, draft.history)) continue
    out.push(finish({
      kind: 'vendor_expense',
      bank_txn_id: txn.id,
      account_id: txn.account_id,
      target_type: 'vendor',
      target_id: String(draft.vendor_profile_id || f.vendor.value),
      amount: txn.amount,
      confidence: draft.rule ? 0.9 : 0.75,
      evidence: [
        { label: 'Fournisseur', detail: `${f.vendor.value} — ${f.vendor.source}` },
        { label: 'Compte', detail: f.expense_account_id.source },
        ...(draft.rule ? [{ label: 'Règle', detail: draft.rule.name }] : []),
      ],
      payload: {
        vendor: f.vendor.value,
        expense_account_id: f.expense_account_id.value,
        tax_code_id: f.tax_code_id.value,
        tax_cad: f.tax.value,
        payment_account_id: f.payment_account_id.value,
        payment_method: f.payment_method.value,
        memo: f.memo.value,
        doc_number: f.doc_number.value,
        qb_type: f.qb_type.value,
        due_date: f.due_date.value,
      },
    }))
  }
  return out
}


// Ce qui autorise une proposition qui publie : une valeur DÉCLARÉE (règle,
// profil, document), ou une habitude franche — au moins trois fois, et au moins
// sept fois sur dix. En dessous, la ligne reste à l'écran sans proposition :
// elle mérite une décision, pas un clic de confirmation.
const HABIT_MIN_TIMES = 3
const HABIT_MIN_SHARE = 0.7

export function isSolidEnoughToPublish(field, history) {
  if (!field?.value || !field.source) return false
  // Ce qu'on a déjà fait pour ce libellé : trois fois au moins, et nettement.
  const memo = /^déjà fait (\d+) fois(?: sur (\d+))?/.exec(field.source)
  if (memo) {
    const n = Number(memo[1]); const of = Number(memo[2] || memo[1])
    return n >= HABIT_MIN_TIMES && n / of >= HABIT_MIN_SHARE
  }
  if (!/^habitude/.test(field.source)) return true
  const top = history?.expense_accounts?.[0]
  if (!top || !history.count) return false
  return top.n >= HABIT_MIN_TIMES && top.n / history.count >= HABIT_MIN_SHARE
}

// ── Comme d'habitude dans QuickBooks ────────────────────────────────────────
// « DEBOURSE MCR » : 113 fois un virement depuis la marge de crédit. Une ligne
// sans pièce ni contrepartie au relevé, dont le libellé a toujours été passé de
// la même façon (virement vers le même compte, dépôt dans le même compte),
// reçoit la proposition de refaire la même écriture. PUBLIE à l'acceptation.
// Les dépenses restent à vendor_expense, qui sait le fournisseur et la taxe.
export async function produceQbHabits(accountId, { limit = 60 } = {}) {
  const { qbHabitFor } = await import('../bankQbHabit.js')
  const { findTransferCandidates } = await import('../bankActions.js')
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account?.qb_account_id || account.kind === 'card') return []
  // Les comptes QuickBooks que l'ERP suit comme comptes bancaires : leur
  // virement se lie aux deux lignes du relevé, pas ici — sauf si l'autre
  // moitié n'est pas au relevé.
  const tracked = new Set(db.prepare('SELECT qb_account_id FROM bank_accounts WHERE deleted_at IS NULL AND qb_account_id IS NOT NULL').all()
    .flatMap((r) => String(r.qb_account_id).split(',').map((s) => s.trim())))
  const txns = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
      AND matched_id IS NULL AND transfer_txn_id IS NULL AND qb_txn_id IS NULL
      AND status='a_traiter' AND COALESCE(pending,0)=0
    ORDER BY txn_date DESC LIMIT ?
  `).all(accountId, limit)
  const out = []
  for (const txn of txns) {
    const h = qbHabitFor(txn)
    if (!h?.strong || !h.account_id || !['transfer', 'deposit'].includes(h.kind)) continue
    if (h.kind === 'deposit' && !(txn.amount > 0)) continue
    if (h.kind === 'transfer' && tracked.has(h.account_id) && findTransferCandidates(txn).some((c) => !c.fx)) continue
    const what = h.kind === 'transfer' ? (txn.amount > 0 ? `Virement depuis ${h.account_name}` : `Virement vers ${h.account_name}`)
      : `Dépôt — ${h.account_name}`
    out.push(finish({
      kind: 'qb_habit',
      bank_txn_id: txn.id,
      account_id: txn.account_id,
      target_type: `qb_${h.kind}`,
      target_id: h.account_id,
      amount: txn.amount,
      confidence: h.n >= 5 && h.n === h.total ? 0.95 : 0.85,
      evidence: [{ label: 'Habitude QuickBooks', detail: `${what} — ${h.source}` }],
      payload: { entity: h.kind, account_id: h.account_id, account_name: h.account_name, memo: h.memo, label: what, n: h.n, total: h.total },
      producer: 'bankQbHabit',
    }))
  }
  return out
}
