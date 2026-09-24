// Venn → bank_transactions. Quatrième source d'alimentation de la table (avec
// le collage manuel, TRX_Orisha et Plaid) — mais une source PROPRE à ses deux
// comptes : TRX_Orisha ne couvre que la BNC, Venn ne couvre que Venn, les deux
// ne se marchent jamais dessus.
//
// Dédup : la clé externe est l'identifiant de transaction Venn
// (`venn:<transaction_id>`), stable d'un passage à l'autre. Relancer la sync
// dix fois ne crée donc aucun doublon — c'est ce qui permet de relire une
// fenêtre large à chaque passage.
//
// La devise n'est JAMAIS convertie à l'import : le compte Venn USD porte des
// montants en USD, point. La conversion trimestrielle reste un geste humain.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { runPostImportHooks, autoMatchAccount, RECEIPT_BANK_MATCH_AUTOMATION_ID } from './bankReconciliation.js'
import { isSystemAutomationActive } from './systemAutomations.js'
import { listVennTransactions } from './venn.js'
import { getConfig, DEFAULTS, isVennConfigured } from '../connectors/venn.js'
import { logSync } from './syncLog.js'

export const vennDedupKey = transactionId => `venn:${transactionId}`

/** Les comptes ERP reliés à un compte Venn. */
export function linkedVennAccounts() {
  return db.prepare(`
    SELECT id, name, currency, venn_account_id
    FROM bank_accounts
    WHERE venn_account_id IS NOT NULL AND venn_account_id <> '' AND deleted_at IS NULL
    ORDER BY sort_order, name
  `).all()
}

// Une ligne déjà connue peut encore bouger tant qu'elle est en attente chez la
// banque (montant, libellé, date de passage). Une fois posée, on n'y touche
// plus : le travail comptable fait dessus (statut, lien QuickBooks, commentaire)
// ne doit jamais être écrasé par une relecture.
export function upsertVennTransaction(accountId, txn) {
  const key = vennDedupKey(txn.venn_transaction_id)
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (id, account_id, txn_date, description, details, reference, amount, dedup_key,
       pending, bank_state, bank_category, txn_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    newRecordId(), accountId, txn.txn_date, txn.description, txn.details,
    txn.venn_transaction_id, txn.amount, key,
    txn.pending ? 1 : 0, txn.pending ? 'en_attente' : 'complete',
    txn.bank_category, txn.txn_type,
  ).changes
  if (inserted) return { inserted: 1, updated: 0 }
  const res = db.prepare(`
    UPDATE bank_transactions
    SET txn_date=?, description=?, details=COALESCE(?, details), amount=?,
        pending=?, bank_state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE dedup_key=? AND deleted_at IS NULL AND pending=1
  `).run(txn.txn_date, txn.description, txn.details, txn.amount,
    txn.pending ? 1 : 0, txn.pending ? 'en_attente' : 'complete', key)
  return { inserted: 0, updated: res.changes }
}

/**
 * Verse un lot de transactions normalisées dans un compte ERP, puis déclenche
 * les MÊMES effets de bord que les autres sources (appariement aux factures,
 * propositions) — rien n'est dupliqué ici, tout passe par
 * services/bankReconciliation.js.
 */
export function importVennTransactions(accountId, txns) {
  let inserted = 0, updated = 0
  let posted = false
  const tx = db.transaction(() => {
    for (const t of txns) {
      const r = upsertVennTransaction(accountId, t)
      inserted += r.inserted
      updated += r.updated
      if (!t.pending && (r.inserted || r.updated)) posted = true
    }
  })
  tx()
  if (posted) {
    if (isSystemAutomationActive(RECEIPT_BANK_MATCH_AUTOMATION_ID)) {
      try { autoMatchAccount(accountId) }
      catch (e) { console.error('vennSync.autoMatchAccount:', e.message) }
    }
    runPostImportHooks(accountId, { source: 'venn' })
  }
  return { inserted, updated }
}

/** Fenêtre lue par défaut : les `lookback_days` derniers jours, jusqu'à demain. */
export function defaultWindow(days = null, today = new Date()) {
  const n = Number(days ?? getConfig().lookback_days ?? DEFAULTS.lookback_days) || 30
  const to = new Date(today.getTime() + 24 * 3600e3)
  const from = new Date(today.getTime() - n * 24 * 3600e3)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

/** Synchronise UN compte ERP relié à Venn. */
export async function syncVennAccount(bankAccountId, { from, to, trigger = 'manual' } = {}) {
  const account = db.prepare(
    'SELECT id, name, venn_account_id FROM bank_accounts WHERE id=? AND deleted_at IS NULL'
  ).get(bankAccountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.venn_account_id) throw new Error(`${account.name} n'est relié à aucun compte Venn`)
  const win = from && to ? { from, to } : defaultWindow()
  const startedAt = Date.now()
  try {
    const txns = await listVennTransactions(account.venn_account_id, win)
    const r = importVennTransactions(account.id, txns)
    logSync('venn', trigger, { status: 'success', modified: r.inserted, durationMs: Date.now() - startedAt })
    return { account: account.name, account_id: account.id, ...win, read: txns.length, ...r }
  } catch (e) {
    logSync('venn', trigger, { status: 'error', error: e.message, durationMs: Date.now() - startedAt })
    throw e
  }
}

/**
 * Passage planifié : tous les comptes reliés, sur la fenêtre par défaut. Un
 * compte qui échoue n'empêche pas les autres — l'erreur est rendue telle quelle.
 */
export async function scheduledVennSync({ trigger = 'scheduled' } = {}) {
  if (!isVennConfigured()) return [{ error: 'Venn n’est pas configuré' }]
  const results = []
  for (const acc of linkedVennAccounts()) {
    try {
      results.push(await syncVennAccount(acc.id, { trigger }))
    } catch (e) {
      results.push({ account: acc.name, account_id: acc.id, error: e.message })
    }
  }
  return results
}

/** État par compte : combien de lignes viennent de Venn, jusqu'à quand. */
export function vennSyncStatus() {
  return linkedVennAccounts().map(acc => {
    const row = db.prepare(`
      SELECT COUNT(*) AS n, MAX(txn_date) AS last_txn_date
      FROM bank_transactions
      WHERE account_id=? AND dedup_key LIKE 'venn:%' AND deleted_at IS NULL
    `).get(acc.id)
    return {
      account_id: acc.id, account_name: acc.name, currency: acc.currency,
      venn_account_id: acc.venn_account_id,
      venn_count: row?.n || 0,
      last_txn_date: row?.last_txn_date || null,
      empty: !row?.n,
    }
  })
}
