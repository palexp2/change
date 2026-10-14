// Passage automatique au vert (« rapproché ») — demande de Charles, 2026-09-26.
//
// L'API Intuit ne sait pas cocher « rapproché » dans QuickBooks ; Boréal pose
// donc le vert chez lui, dans deux cas sûrs seulement :
//   • qb_rapproche — l'écriture QuickBooks liée est DÉJÀ rapprochée là-bas (« R ») ;
//   • ecart_zero   — le solde du relevé et celui de QuickBooks à la même date
//     sont identiques au cent : toutes les lignes jaunes jusqu'à cette date
//     passent au vert ;
//   • liste_banque — AVANT le relevé : la liste des transactions reçue dans
//     Boréal vient de la banque et fait foi (Charles, 2026-10-10 pour les
//     cartes ; 2026-10-13 étendu à tous les comptes : « dès que j'ai
//     comptabilisé, que ça se mette en vert »). Une ligne jaune postérieure au
//     dernier relevé, liée à son écriture QuickBooks AU MONTANT EXACT, passe au
//     vert. Un écart de montant reste jaune : c'est une anomalie à signaler.
//     Puis (même jour, « oui ») : plus de condition de date — chaque ligne
//     comptabilisée au bon montant est verte même si le compte ne balance pas ;
//     l'écart du compte est dit par la bulle Claude (bankClaude.js).
// Une ligne dont un humain a annulé le rapprochement (reconcile_method =
// 'annule') n'est plus jamais touchée. Réglage : `auto_reconcile` de
// l'automation sys_bank_qb_verify (vider = couper).
import db from '../db/database.js'
import { touchBankTxns } from './realtimeEmitters.js'
import { noteGreen } from './bankClaude.js'

export const AUTO_RECONCILE_METHODS = ['qb_rapproche', 'ecart_zero', 'liste_banque']

export function parseAutoReconcile(v) {
  return new Set(String(v || '').split(',').map((x) => x.trim()).filter((x) => AUTO_RECONCILE_METHODS.includes(x)))
}

function markReconciled(ids, method) {
  if (!ids.length) return 0
  const stmt = db.prepare(`
    UPDATE bank_transactions
    SET status='rapproche', reconciled_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reconciled_by=NULL,
        reconcile_method=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND deleted_at IS NULL AND status NOT IN ('rapproche','ignore')
      AND COALESCE(reconcile_method, '') != 'annule'
  `)
  const done = []
  db.transaction(() => { for (const id of ids) if (stmt.run(method, id).changes) done.push(id) })()
  if (done.length) {
    touchBankTxns(done)
    try { noteGreen(done) } catch (e) { console.error('bankClaude.noteGreen:', e.message) }
  }
  return done.length
}

/** Cas 1 : l'écriture liée est rapprochée dans QuickBooks. `matches` = verdict de searchAccount. */
export function reconcileFromQbCleared(matches, txnById) {
  const ids = []
  for (const [txnId, m] of matches) {
    const t = txnById.get(txnId)
    if (!t || t.status === 'rapproche' || !m.entries?.length) continue
    if (m.entries.every((e) => e.cleared === 'R')) ids.push(txnId)
  }
  return markReconciled(ids, 'qb_rapproche')
}

/** Cas 2 : écart relevé ↔ QuickBooks nul à la date du relevé. Appelle QuickBooks. */
export async function reconcileIfBalanced(accountId) {
  const yellow = db.prepare(`
    SELECT COUNT(*) AS n FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status='comptabilise'
      AND COALESCE(pending, 0) = 0 AND COALESCE(reconcile_method, '') != 'annule'
  `).get(accountId).n
  if (!yellow) return 0
  const { compareWithQb } = await import('./bankReconcileSummary.js')
  const cmp = await compareWithQb(accountId)
  const b = cmp?.balance
  if (!b || b.error || b.difference == null || Math.abs(b.difference) >= 0.005 || !b.statement_date) return 0
  const ids = db.prepare(`
    SELECT id FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status='comptabilise'
      AND COALESCE(pending, 0) = 0 AND txn_date <= ?
  `).all(accountId, b.statement_date).map((r) => r.id)
  return markReconciled(ids, 'ecart_zero')
}

/** Cas 3 : toute ligne liée à QuickBooks sans écart de montant, même si le compte ne balance pas encore (Charles, 2026-10-13). Local. */
export async function reconcileFromBankList(accountId) {
  const ids = db.prepare(`
    SELECT id FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status='comptabilise'
      AND COALESCE(pending, 0) = 0 AND qb_txn_id IS NOT NULL AND qb_txn_id != ''
      AND ABS(COALESCE(qb_match_delta, 0)) < 0.005
  `).all(accountId).map((r) => r.id)
  return markReconciled(ids, 'liste_banque')
}
