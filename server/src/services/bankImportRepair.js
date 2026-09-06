// Réparation des montants de l'import historique du 2026-07-28 (TRX_Orisha.xlsx).
//
// Deux défauts distincts, constatés en comparant le relevé au grand livre
// QuickBooks (73 lignes de 2024-2025 restaient « à traiter » alors que QB les
// portait toutes) :
//
//   • MasterCard BNC — le montant importé est celui de la DEVISE d'origine
//     (USD, EUR) alors que la carte a été débitée en CAD. Le montant CAD est
//     dans le libellé, après le « — » : « HEMINGWAYAPP,COM … — -141,99 » sur
//     une ligne à -100.
//   • Desjardins CAD/USD — le montant importé est le SOLDE, pas le montant :
//     48 869,66 au relevé là où QB a un dépôt de 48 245 — l'écart, 624,66,
//     étant exactement la ligne précédente. Ici seule l'écriture QB dit la
//     vérité, d'où l'appariement par date exacte.
//
// Réparation ponctuelle, déclenchée par POST /api/bank/accounts/:id/repair-import.
import db from '../db/database.js'
import { fetchQbLedger } from './bankQbLink.js'
import { refreshStatuses } from './bankReconciliation.js'
import { shiftDate } from '../utils/datetime.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const EPSILON = 0.005
const LABEL_AMOUNT = / — (-?[\d.]+)\s*$/

// Montant que le libellé du relevé porte en queue, ou null s'il n'en porte pas.
export function labelledAmount(description) {
  const m = LABEL_AMOUNT.exec(String(description || ''))
  if (!m) return null
  const n = Math.abs(Number(m[1]))
  return Number.isFinite(n) && n !== 0 ? n : null
}

// Montant réellement débité, tel que le libellé du relevé le porte en queue.
// Renvoie null si le libellé ne dit rien de plus que le montant déjà en base :
// le signe existant est CONSERVÉ (le relevé MasterCard note certains achats en
// positif, et detectSign — bankQbSearch.js — s'appuie dessus).
export function repairFromLabel(txn) {
  const labelled = labelledAmount(txn.description)
  if (labelled == null) return null
  const current = Math.abs(Number(txn.amount))
  if (Math.abs(labelled - current) < EPSILON) return null
  return { amount: (Math.sign(Number(txn.amount)) || 1) * labelled, strategy: 'devise' }
}

// Montant tiré de l'écriture QuickBooks du MÊME jour. Exigence délibérément
// stricte : une seule écriture non appariée à cette date, sinon on ne devine
// pas et la ligne reste à traiter à la main.
export function repairFromQbLedger(txn, unmatchedEntries) {
  const sameDay = (unmatchedEntries || []).filter((e) => e.date === txn.txn_date)
  if (sameDay.length !== 1) return null
  const entry = sameDay[0]
  const amount = (Math.sign(Number(txn.amount)) || 1) * Math.abs(entry.amount)
  if (Math.abs(amount - Number(txn.amount)) < EPSILON) return null
  return { amount, strategy: 'solde', qb: entry }
}

function accountById(id) {
  return db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(id)
}

// Plan de réparation d'un compte sur une fenêtre. N'ÉCRIT RIEN.
export async function planRepair(accountId, { from = '2024-01-01', to = '2025-12-31', fetchLedger = fetchQbLedger } = {}) {
  const account = accountById(accountId)
  if (!account) throw new Error('Compte introuvable')
  // Une ligne rapprochée est figée : on ne réécrit jamais son montant.
  const txns = db.prepare(`
    SELECT id, txn_date, description, amount, balance, status, qb_txn_id
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status <> 'rapproche'
      AND txn_date BETWEEN ? AND ?
    ORDER BY txn_date, rowid
  `).all(accountId, from, to)

  const rows = []
  const pending = []
  for (const t of txns) {
    const fix = repairFromLabel(t)
    if (fix) rows.push({ ...t, new_amount: fix.amount, strategy: fix.strategy, qb: null })
    // Un libellé qui porte déjà le bon montant ferme le dossier : la ligne est
    // juste, et la laisser passer au grand livre reviendrait à lui coller le
    // montant d'une écriture voisine (vu : un achat McMaster-Carr correct à
    // 208,48 $ se voyait proposer 138,48 $).
    else if (labelledAmount(t.description) == null) pending.push(t)
  }

  // Deuxième stratégie : le grand livre QB, uniquement pour ce que le libellé
  // n'a pas su corriger et si le compte est mappé.
  //
  // Elle est mise en veille tant que la première a du travail : un compte
  // souffre d'un défaut ou de l'autre, et une écriture QB qui semble « libre »
  // est peut-être celle qu'une ligne corrigée par le libellé va réclamer. Vu
  // pour de vrai : un achat Digi-Key correct se voyait proposer le montant
  // d'un achat OpenAI du même jour, encore non lié. On applique donc le
  // libellé, on relance la liaison QB, puis on rejoue ce plan : le second
  // passage ne voit plus que des écritures réellement orphelines.
  if (pending.length && account.qb_account_id && rows.length === 0) {
    const qbIds = String(account.qb_account_id).split(',').map((s) => s.trim()).filter(Boolean)
    const entries = []
    for (const id of qbIds) entries.push(...await fetchLedger(id, shiftDate(from, -5), shiftDate(to, 5)))
    // Les écritures déjà portées par une ligne du relevé sont hors jeu.
    const taken = new Set(db.prepare(`
      SELECT qb_txn_id FROM bank_transactions
      WHERE account_id=? AND deleted_at IS NULL AND qb_txn_id IS NOT NULL
    `).all(accountId).map((r) => String(r.qb_txn_id)))
    const free = entries.filter((e) => !taken.has(String(e.qbId)))
    // L'appariement se fait par date : il faut qu'elle ne désigne qu'une seule
    // ligne de relevé, sinon la même écriture serait recopiée sur toutes
    // (cinq achats du 19 décembre se voyaient proposer le même 71,37 $).
    const perDate = new Map()
    for (const t of pending) perDate.set(t.txn_date, (perDate.get(t.txn_date) || 0) + 1)
    for (const t of pending) {
      if (perDate.get(t.txn_date) !== 1) continue
      const fix = repairFromQbLedger(t, free)
      if (fix) rows.push({ ...t, new_amount: fix.amount, strategy: fix.strategy, qb: fix.qb })
    }
  }

  rows.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0))
  return {
    account: { id: account.id, name: account.name },
    period: { from, to },
    scanned: txns.length,
    rows,
    skipped: txns.length - rows.length,
  }
}

// Applique un plan produit par planRepair. L'ancienne valeur (le solde, dans le
// cas Desjardins) atterrit dans la colonne Solde, où elle est vraie.
export function applyRepair(plan) {
  const setAmount = db.prepare(`
    UPDATE bank_transactions
    SET amount=?, balance=COALESCE(balance, ?), updated_at=${NOW}
    WHERE id=? AND deleted_at IS NULL AND status <> 'rapproche'
  `)
  const setQb = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=?, qb_txn_id=?, qb_match_method='manuel', qb_match_delta=NULL,
        updated_at=${NOW}
    WHERE id=? AND qb_txn_id IS NULL
  `)
  let repaired = 0
  let linked = 0
  const tx = db.transaction(() => {
    for (const r of plan.rows) {
      repaired += setAmount.run(r.new_amount, r.amount, r.id).changes
      if (r.qb?.qbId) linked += setQb.run(r.qb.entity, String(r.qb.qbId), r.id).changes
    }
  })
  tx()
  const restatused = refreshStatuses(plan.account.id)
  return { repaired, linked, restatused }
}
