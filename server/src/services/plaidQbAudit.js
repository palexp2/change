// Vérification robuste « comptabilisé dans QuickBooks » pour les comptes
// branchés à Plaid (BNC). Remplace, pour ces comptes-là, le rôle que jouait
// l'audit TRX_Orisha (voir bankTrxSheet.js:auditAccountVsQb) — mais sans la
// comparaison au fichier Excel (Plaid n'a pas de couleur peinte à la main) et
// SANS plafond de 45 jours : le but explicite est de rattraper l'historique
// 2024-2025, que l'audit TRX_Orisha n'a jamais couvert.
//
// Réutilise le moteur de recherche approfondie (bankQbSearch.js) — tolérance
// de montant, fenêtre élargie, virements internes, devises — déjà validé sur
// TRX_Orisha (83 des 94 anomalies du 22 août 2026 étaient des faux positifs de
// l'ancien matcher naïf). Le résultat s'écrit directement sur `qb_txn_id` /
// `qb_match_*`, seule preuve retenue par deriveStatus() pour un compte Plaid
// (voir bankReconciliation.js — sheet_color y est ignoré).
import db from '../db/database.js'
import { refreshStatuses } from './bankReconciliation.js'
import { buildLedgerIndex, searchAccount, persistMatches, verifyConversions } from './bankQbSearch.js'
import { logSync } from './syncLog.js'
import { shiftDate } from '../utils/datetime.js'

// Passage périodique (scheduler) : fenêtre glissante, suffisante pour du
// courant. Le bouton manuel passe `sinceDays: null` pour tout l'historique.
export const ROLLING_AUDIT_DAYS = 90
// Plancher de l'historique importé dans l'ERP (voir bankTrxSheet.js) — un vrai
// « 2000-01-01 » fait planter le rapport GeneralLedger de QuickBooks (500,
// rapport trop large sur ±11 comptes) sans rien couvrir de réel avant cette
// date de toute façon.
const FLOOR_DATE = '2024-01-01'

function plaidAccounts() {
  return db.prepare(`
    SELECT * FROM bank_accounts
    WHERE deleted_at IS NULL AND plaid_account_id IS NOT NULL
      AND qb_account_id IS NOT NULL AND qb_account_id != ''
  `).all()
}

// Audite une liste de comptes (déjà filtrés Plaid + mappés QB) en un seul
// passage : un seul index de grand livre construit pour TOUS les comptes
// mappés QB (Plaid ou non) — un virement interne BNC↔Desjardins doit pouvoir
// se résoudre du côté de l'autre compte.
async function auditAccounts(accounts, { sinceDays, trigger }) {
  if (!accounts.length) return []
  const todayIso = new Date().toISOString().slice(0, 10)
  const from = sinceDays ? shiftDate(todayIso, -sinceDays) : FLOOR_DATE

  const allQbAccounts = db.prepare(`
    SELECT * FROM bank_accounts WHERE deleted_at IS NULL AND qb_account_id IS NOT NULL AND qb_account_id != ''
  `).all()
  const ledgerFrom = sinceDays ? shiftDate(from, -35) : FLOOR_DATE
  const ledgerTo = shiftDate(todayIso, 5)
  const index = await buildLedgerIndex(allQbAccounts, ledgerFrom, ledgerTo)

  const results = []
  for (const account of accounts) {
    const t0 = Date.now()
    try {
      const bankTxns = db.prepare(`
        SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description,
               details, reference, amount, status, matched_id, matched_type, sheet_color, qb_txn_id
        FROM bank_transactions
        WHERE account_id=? AND deleted_at IS NULL AND status NOT IN ('ignore','rapproche')
          AND pending = 0 AND txn_date >= ?
        ORDER BY txn_date
      `).all(account.id, from)

      let linked = 0
      let matchedCount = 0
      if (bankTxns.length) {
        const { matches } = searchAccount(account, bankTxns, index)
        await verifyConversions(matches, new Map(bankTxns.map((t) => [t.id, t])))
        linked = persistMatches(matches)
        matchedCount = matches.size
      }
      refreshStatuses(account.id)
      logSync('plaid_qb_audit', trigger, { status: 'success', modified: linked, durationMs: Date.now() - t0 })
      results.push({ account_id: account.id, account_name: account.name, scanned: bankTxns.length, matched: matchedCount, linked })
    } catch (e) {
      logSync('plaid_qb_audit', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      results.push({ account_id: account.id, account_name: account.name, error: e.message })
    }
  }
  return results
}

// Audit d'UN compte, à la demande (bouton « Revérifier avec QuickBooks »).
// sinceDays: null → tout l'historique (usage prévu pour le premier passage).
export async function auditPlaidAccountVsQb(accountId, { sinceDays = null, trigger = 'manual' } = {}) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.plaid_account_id) throw new Error('Ce compte n\'est pas branché à Plaid')
  if (!account.qb_account_id) throw new Error('Compte non mappé à QuickBooks')
  const [result] = await auditAccounts([account], { sinceDays, trigger })
  if (result.error) throw new Error(result.error)
  return result
}

// Passage périodique : tous les comptes Plaid mappés QB, fenêtre glissante.
let auditRunning = false
export async function scheduledPlaidQbAudit() {
  if (auditRunning) return
  auditRunning = true
  try {
    return await auditAccounts(plaidAccounts(), { sinceDays: ROLLING_AUDIT_DAYS, trigger: 'scheduled' })
  } finally { auditRunning = false }
}
