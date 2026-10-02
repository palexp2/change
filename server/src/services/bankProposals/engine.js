/**
 * Le moteur du rapprochement : un passage, tous les producteurs, un bilan.
 *
 * L'ORDRE compte, et c'est tout ce qu'il y a d'intelligent ici. Chaque étape
 * écarte les lignes qu'une étape précédente a déjà réclamées, du plus sûr au
 * plus spéculatif :
 *
 *   1. qb_link         — l'écriture existe déjà dans QuickBooks (posé ailleurs,
 *                        pendant la sync, qui seule dispose du grand livre) ;
 *   2. doc_match       — l'ERP possède déjà la pièce ;
 *   3. paie_debit, debt_payment, aga_repartition — une sortie connue d'avance ;
 *   4. payment_clear   — un paiement émis vient de passer ;
 *   5. vendor_expense  — dernier recours : aucune pièce nulle part, mais le
 *                        dossier est complet.
 *
 * Rien ici n'écrit dans la comptabilité : le moteur PROPOSE. Deux natures
 * publieront dans QuickBooks quand on les acceptera (la répartition AGA et la
 * dépense sans pièce) ; jamais sans le clic.
 *
 * Le moteur ne construit JAMAIS son propre index du grand livre QuickBooks : ce
 * travail appartient à la sync TRX_Orisha, une fois par 20 minutes pour les
 * onze comptes. D'où l'absence de `qb_link` ci-dessous.
 */
import db from '../../db/database.js'
import { dedupeClaims } from './model.js'
import { reconcileAndPersist } from './store.js'
import {
  producePaymentClears, producePaieDebits, produceDebtPayments,
  produceDocMatches, produceAgaRepartition, produceVendorExpenses,
} from './producers.js'
import { invalidateBankLabelCache } from '../scrapers/vendorFromBankLabel.js'
import { invalidateBankRulesCache } from '../bankRules/store.js'

export const ENGINE_KINDS = [
  'doc_match', 'paie_debit', 'debt_payment', 'aga_repartition',
  'payment_clear', 'vendor_expense',
]

const accountsOf = (accountId) => (accountId
  ? db.prepare('SELECT id, name FROM bank_accounts WHERE id=? AND deleted_at IS NULL').all(accountId)
  : db.prepare('SELECT id, name FROM bank_accounts WHERE deleted_at IS NULL').all())

/**
 * Un passage complet.
 *
 * @param accountId    un seul compte, ou tous
 * @param dryRun       produire sans rien enregistrer (pour la simulation)
 * @param kinds        restreindre aux natures voulues
 * @param maxOpen      plafond de propositions vivantes — au-delà, on arrête de
 *                     produire plutôt que d'enterrer l'utilisateur
 */
export async function runBankEngine({ accountId = null, dryRun = false, kinds = ENGINE_KINDS, maxOpen = 200 } = {}) {
  // Un motif de fournisseur ou une règle éditée il y a deux minutes doit valoir
  // pour ce passage-ci.
  invalidateBankLabelCache()
  invalidateBankRulesCache()

  const wanted = new Set(kinds)
  const open = db.prepare("SELECT COUNT(*) n FROM bank_proposals WHERE status='proposee'").get().n
  const room = Math.max(0, maxOpen - open)

  const byKind = {}
  const errors = []
  const claimed = new Set()

  // Chaque étape ne voit que les lignes encore libres dans CE passage.
  const step = async (kind, produce) => {
    if (!wanted.has(kind)) return
    let produced = []
    try { produced = await produce() } catch (e) { errors.push(`${kind}: ${e.message}`); return }
    const fresh = dedupeClaims(produced).filter((p) => !claimed.has(p.bank_txn_id))
    for (const p of fresh) claimed.add(p.bank_txn_id)
    // Une nature est produite compte par compte : les chiffres s'AJOUTENT,
    // sinon le bilan ne montrerait que le dernier compte balayé.
    const tally = byKind[kind] || (byKind[kind] = { produced: 0, inserted: 0, revived: 0 })
    tally.produced += fresh.length
    if (dryRun || !fresh.length) return
    try {
      const res = reconcileAndPersist(fresh, { accountId, kinds: [kind] })
      tally.inserted += res.inserted
      tally.revived += res.revived ?? 0
    } catch (e) {
      errors.push(`${kind}: ${e.message}`)
    }
  }

  const accounts = accountsOf(accountId)

  for (const account of accounts) {
    await step('doc_match', () => produceDocMatches(account.id))
  }
  await step('paie_debit', async () => producePaieDebits())
  await step('debt_payment', () => produceDebtPayments())
  await step('aga_repartition', () => produceAgaRepartition())
  for (const account of accounts) {
    await step('payment_clear', async () => producePaymentClears({ accountName: account.name, accountId: account.id }))
  }
  // Le dernier recours ne s'exécute que s'il reste de la place : mieux vaut
  // vingt propositions qu'on regarde que deux cents qu'on ignore.
  if (room > 0) {
    for (const account of accounts) {
      await step('vendor_expense', () => produceVendorExpenses(account.id, { limit: Math.min(40, room) }))
    }
  }

  // Les sûres, sans QuickBooks, s'appliquent seules (annulables).
  let auto = { accepted: 0 }
  try {
    const { autoAcceptSafe } = await import('./autoAccept.js')
    auto = await autoAcceptSafe({ dryRun })
  } catch (e) { errors.push(`auto: ${e.message}`) }

  const produced = Object.values(byKind).reduce((s, x) => s + x.produced, 0)
  const inserted = Object.values(byKind).reduce((s, x) => s + x.inserted, 0)
  return {
    dryRun,
    accounts: accounts.length,
    produced,
    inserted,
    open_after: db.prepare("SELECT COUNT(*) n FROM bank_proposals WHERE status='proposee'").get().n,
    by_kind: byKind,
    auto_accepted: auto.accepted || 0,
    errors,
    summary: summarizeRun({ produced, inserted, byKind, dryRun }),
  }
}

// Le bilan en une phrase, celle qui s'affiche après une sync.
export function summarizeRun({ produced, inserted, byKind, dryRun }) {
  if (!produced) return 'Rien de nouveau à confirmer'
  const parts = Object.entries(byKind)
    .filter(([, v]) => v.produced)
    .map(([k, v]) => `${v.produced} ${KIND_LABEL[k] || k}`)
  return `${dryRun ? 'Simulation : ' : ''}${inserted || produced} à confirmer — ${parts.join(', ')}`
}

const KIND_LABEL = {
  doc_match: 'pièces retrouvées',
  paie_debit: 'paies',
  debt_payment: 'versements de dette',
  aga_repartition: 'assurance collective',
  payment_clear: 'paiements passés',
  vendor_expense: 'dépenses prêtes',
}
