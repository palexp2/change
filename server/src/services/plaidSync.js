// Mapping Plaid → bank_transactions. Troisième source d'alimentation de la
// table (avec le collage manuel et TRX_Orisha, voir bankReconciliation.js),
// mais avec une stratégie de dédup différente : Plaid fournit un
// transaction_id stable, donc pas besoin de la signature date+montant+
// occurrence utilisée pour le sheet (fragile face aux modifications).
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { runPostImportHooks, autoMatchAccount, purgeZeroAmountTxns, RECEIPT_BANK_MATCH_AUTOMATION_ID } from './bankReconciliation.js'
import { isSystemAutomationActive } from './systemAutomations.js'
import { syncItemTransactions, fetchItemBalances, listItems, itemHealth, requestTransactionsRefresh } from '../connectors/plaid.js'
import { logSync } from './syncLog.js'
import { TREASURY_BANK_ACCOUNT, recordBalance, checkBalanceVariance } from './treasury.js'

const plaidDedupKey = transactionId => `plaid:${transactionId}`

// Plaid : positif = argent qui SORT du compte, négatif = argent qui ENTRE.
// bank_transactions (comme le reste de l'ERP) suit la convention inverse —
// relevé bancaire classique où un dépôt est positif, un retrait négatif.
const toLedgerAmount = plaidAmount => Math.round(-plaidAmount * 100) / 100

// Libellé : l'UI et l'appariement fournisseur lisent COALESCE(details,
// description) — `details` d'abord. Plaid donne deux niveaux : `name` (le
// libellé brut du relevé, « COMPTE DIVERS DT NETHRIS PAIE ») et
// `merchant_name` (le commerçant normalisé, « Nethris »). On garde les deux
// quand ils diffèrent : le brut dans `details` (c'est ce que l'humain
// reconnaît sur son relevé), le normalisé dans `description`.
function labelsFor(txn) {
  const raw = txn.name || null
  const merchant = txn.merchant_name || null
  if (merchant && raw && merchant !== raw) return { description: merchant, details: raw }
  return { description: merchant || raw, details: null }
}

function upsertAdded(accountId, txn) {
  if (!toLedgerAmount(txn.amount)) return 0 // 0 $ : rien à rapprocher
  const { description, details } = labelsFor(txn)
  const res = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (id, account_id, txn_date, description, details, reference, amount, dedup_key, pending, bank_state)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    newRecordId(), accountId, txn.date, description, details,
    txn.transaction_id, toLedgerAmount(txn.amount), plaidDedupKey(txn.transaction_id),
    txn.pending ? 1 : 0,
    txn.pending ? 'en_attente' : 'complete'
  )
  return res.changes
}

function updateModified(txn) {
  const { description, details } = labelsFor(txn)
  db.prepare(`
    UPDATE bank_transactions
    SET description=?, details=COALESCE(?, details), txn_date=?, amount=?, pending=?, bank_state=?
    WHERE dedup_key=? AND deleted_at IS NULL
  `).run(description, details, txn.date, toLedgerAmount(txn.amount),
    txn.pending ? 1 : 0, txn.pending ? 'en_attente' : 'complete',
    plaidDedupKey(txn.transaction_id))
}

function removeTxn(transactionId) {
  db.prepare(`
    UPDATE bank_transactions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE dedup_key=? AND deleted_at IS NULL
  `).run(plaidDedupKey(transactionId))
}

// Transforme le résultat brut de /transactions/sync pour UN item Plaid (qui
// peut couvrir plusieurs comptes ERP) et applique les effets de bord partagés
// avec les autres sources (autoClearFromBank, détection subventions/Twilio).
export function importPlaidTransactions(accountsByPlaidId, { added, modified, removed }) {
  // Les effets de bord (auto-clear, détection reçus/Twilio) ne se déclenchent
  // que sur une transaction POSTÉE — une transaction encore en attente peut
  // changer de montant avant de se confirmer.
  const touchedAccounts = new Set()
  let inserted = 0
  const tx = db.transaction(() => {
    for (const txn of added) {
      const accountId = accountsByPlaidId.get(txn.account_id)
      if (!accountId) continue
      inserted += upsertAdded(accountId, txn)
      if (!txn.pending) touchedAccounts.add(accountId)
    }
    for (const txn of modified) {
      const accountId = accountsByPlaidId.get(txn.account_id)
      updateModified(txn)
      if (!txn.pending && accountId) touchedAccounts.add(accountId)
    }
    for (const txn of removed) {
      removeTxn(txn.transaction_id)
    }
  })
  tx()
  // Une ligne modifiée à 0 $ (autorisation annulée) sort de la liste.
  try { purgeZeroAmountTxns() } catch (e) { console.error('plaidSync.purgeZeroAmountTxns:', e.message) }
  // Appariement aux documents de l'ERP. Le collage manuel et la sync
  // TRX_Orisha le déclenchaient déjà, jamais Plaid : sur les comptes branchés,
  // une facture pourtant déjà extraite restait « à traiter » jusqu'à un clic
  // sur « Rapprocher ». Les transactions en attente sont exclues plus haut —
  // leur montant peut encore bouger avant de se poser.
  const matching = isSystemAutomationActive(RECEIPT_BANK_MATCH_AUTOMATION_ID)
  for (const accountId of touchedAccounts) {
    if (matching) {
      try { autoMatchAccount(accountId) }
      catch (e) { console.error('plaidSync.autoMatchAccount:', e.message) }
    }
    runPostImportHooks(accountId, { source: 'plaid' })
  }
  return { inserted, touchedAccounts: [...touchedAccounts] }
}

// ── Solde du compte de projection ────────────────────────────────────────────
// Le solde « noté » de /comptabilite se saisissait à la main (et, un temps,
// venait du fichier Drive « Maintien du solde disponible BNC »). Plaid le
// donne à chaque sync : on l'enregistre comme n'importe quelle saisie, avec
// source='plaid'. Anti-bruit : un solde identique noté depuis moins de 6 h
// n'est pas ré-enregistré (la sync passe toutes les 10 min) — mais sa date de
// confirmation, elle, est rafraîchie à chaque passage : c'est elle que la page
// affiche, sinon un solde stable a l'air vieux de six heures.
const BALANCE_MIN_AGE_MIN = 6 * 60

// ⚠️ Sur le compte chèques BNC, `current` ne veut rien dire : le compte est
// BALAYÉ par la marge MCR et retombe à quelques dollars (163,54 $ mesuré le
// 2026-09-06) tandis que l'argent réellement utilisable — marge comprise — est
// dans `available` (56 599,54 $ le même jour). C'est bien `available` que
// suivait le fichier « Maintien du solde disponible BNC », et c'est lui que la
// projection attend : prendre `current` ferait crier le découvert tous les
// jours. `current` ne sert que de repli pour un compte sans disponible.
// Plaid renvoie TOUJOURS un solde, même quand la banque ne lui livre plus rien :
// c'est son dernier montant en cache. Constaté le 2026-10-03 — BNC muette
// depuis le 28 sept., 131 472 $ « confirmés » toutes les 10 min alors que le
// vrai solde était 17 934 $, et la saisie à la main de Charles allait être
// écrasée au passage suivant. La date qui compte est donc celle de la dernière
// livraison réussie de la banque (`bankUpdatedAt`, itemGet), pas l'heure de
// l'appel.
export const BANK_STALE_HOURS = 24

export function plaidBalanceSkipReason(bankUpdatedAt, { now = Date.now(), staleHours = BANK_STALE_HOURS } = {}) {
  if (!bankUpdatedAt) return null
  const t = new Date(bankUpdatedAt).getTime()
  if (!Number.isFinite(t)) return null
  if ((now - t) / 3600e3 >= staleHours) return 'stale'
  // Un solde saisi à la main APRÈS la dernière livraison de la banque est plus
  // frais que tout ce que Plaid peut redire.
  const manual = db.prepare(
    "SELECT noted_at FROM treasury_balances WHERE COALESCE(source,'') <> 'plaid' ORDER BY noted_at DESC LIMIT 1"
  ).get()
  if (manual && new Date(manual.noted_at).getTime() > t) return 'manual_newer'
  return null
}

export function recordPlaidBalance(balances, { minAgeMinutes = BALANCE_MIN_AGE_MIN, bankUpdatedAt = null } = {}) {
  const account = db.prepare(
    'SELECT id, plaid_account_id FROM bank_accounts WHERE name=? AND deleted_at IS NULL'
  ).get(TREASURY_BANK_ACCOUNT)
  if (!account?.plaid_account_id) return null
  const row = (balances || []).find(b => b.plaid_account_id === account.plaid_account_id)
  // `available` tient compte des retenues (le vrai argent utilisable) ; on
  // retombe sur `current` quand la banque ne le donne pas.
  const balance = row?.available ?? row?.current
  if (balance == null) return null
  const skipReason = plaidBalanceSkipReason(bankUpdatedAt)
  if (skipReason) return { balance, skipped: true, skip_reason: skipReason, bank_updated_at: bankUpdatedAt }
  const { entry, skipped } = recordBalance({ balance, source: 'plaid', minAgeMinutes })
  if (!skipped) checkBalanceVariance(entry.id, { trigger: 'solde Plaid' }).catch(() => {})
  return { balance, skipped, entry_id: entry.id }
}

// ── Lecture des transactions : coupée par défaut depuis le 2026-09-12 ───────
// Constat de Charles, chiffré : sur les dix comptes mappés, un seul (BNC CAD)
// recevait vraiment ses transactions, et plus rien depuis le 31 août. Le
// fichier TRX_Orisha redevient donc la source des transactions pour TOUS les
// comptes (services/bankTrxSheet.js) — et Plaid cesse d'écrire dans
// bank_transactions, sinon chaque mouvement finirait en double (les deux
// sources ne partagent pas leur clé de dédup).
// Ce qui RESTE actif : le solde, que la projection de trésorerie lit
// (recordPlaidBalance ci-dessus) — c'est la seule chose que Plaid livre bien.
// Remettre `import_transactions` à '1' dans l'automation sys_plaid_sync
// rallume la lecture des transactions ; le curseur n'a pas bougé entre-temps,
// rien n'est perdu.
export function plaidImportsTransactions() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get('sys_plaid_sync')
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  return String(cfg.import_transactions ?? '0').trim() === '1'
}

// Dernière livraison réussie de la banque chez Plaid ; null si illisible (on
// garde alors l'ancien comportement plutôt que de tout bloquer).
async function bankLastDelivery(itemId) {
  try { return (await itemHealth(itemId)).last_successful_update || null }
  catch (e) {
    console.error('plaidSync.bankLastDelivery:', e?.response?.data?.error_message || e.message)
    return null
  }
}

// Point d'entrée appelé par le webhook Plaid et par la sync manuelle : sync
// l'item auprès de Plaid, mappe vers bank_transactions, journalise.
export async function syncPlaidItem(itemId, trigger = 'webhook', { balanceMinAgeMinutes } = {}) {
  const startedAt = Date.now()
  try {
    // Transactions coupées : on ne lit QUE le solde, et surtout on ne fait pas
    // avancer le curseur — de quoi tout relire le jour où Plaid redeviendrait
    // fiable.
    if (!plaidImportsTransactions()) {
      const { balances } = await fetchItemBalances(itemId)
      const result = { inserted: 0, touchedAccounts: [], transactions_disabled: true }
      try {
        const bankUpdatedAt = await bankLastDelivery(itemId)
        result.balance = recordPlaidBalance(balances, { ...(balanceMinAgeMinutes == null ? {} : { minAgeMinutes: balanceMinAgeMinutes }), bankUpdatedAt })
      } catch (e) {
        console.error('plaidSync.recordPlaidBalance:', e.message)
      }
      logSync('plaid', trigger, { status: 'success', modified: 0, durationMs: Date.now() - startedAt })
      return result
    }
    const { added, modified, removed, accounts, balances } = await syncItemTransactions(itemId)
    const accountsByPlaidId = new Map()
    for (const acc of accounts || []) {
      const row = db.prepare('SELECT id FROM bank_accounts WHERE plaid_account_id=? AND deleted_at IS NULL').get(acc.plaid_account_id)
      if (row) accountsByPlaidId.set(acc.plaid_account_id, row.id)
    }
    const result = importPlaidTransactions(accountsByPlaidId, { added, modified, removed })
    try {
      const bankUpdatedAt = await bankLastDelivery(itemId)
      result.balance = recordPlaidBalance(balances, { ...(balanceMinAgeMinutes == null ? {} : { minAgeMinutes: balanceMinAgeMinutes }), bankUpdatedAt })
    } catch (e) {
      // Le solde ne doit jamais faire échouer la sync des transactions.
      console.error('plaidSync.recordPlaidBalance:', e.message)
    }
    logSync('plaid', trigger, { status: 'success', modified: result.inserted, durationMs: Date.now() - startedAt })
    return result
  } catch (e) {
    logSync('plaid', trigger, { status: 'error', error: e.message, durationMs: Date.now() - startedAt })
    throw e
  }
}

// ── Lecture du solde à la demande ───────────────────────────────────────────
// Le passage planifié (30 min) tient le solde à jour tout seul, mais après un
// virement on veut le chiffre MAINTENANT : ce bouton demande à Plaid
// d'interroger la banque, relit l'item et note le solde sans l'anti-bruit de
// 6 h — un clic est une demande explicite, il doit laisser une lecture datée.
// Pas de produit Balance (solde en direct, facturé à l'appel) : essayé le
// 2026-09-26, la BNC le refusait presque toujours — abandonné par Charles.
export async function refreshTreasuryBalance() {
  const account = db.prepare(
    'SELECT id, plaid_item_id FROM bank_accounts WHERE name=? AND deleted_at IS NULL'
  ).get(TREASURY_BANK_ACCOUNT)
  if (!account?.plaid_item_id) {
    throw new Error(`${TREASURY_BANK_ACCOUNT} n'est pas relié à la banque`)
  }
  // Relecture refusée ou muette (8 s max) : non bloquant, on lit quand même le
  // dernier solde que Plaid détient.
  let woke = true
  try { await requestTransactionsRefresh(account.plaid_item_id, { timeout: 8000 }) }
  catch (e) {
    woke = false
    console.error('plaidSync.refreshTreasuryBalance/refresh:', e?.response?.data?.error_code || '', e?.response?.data?.error_message || e.message)
  }
  const result = await syncPlaidItem(account.plaid_item_id, 'manual', { balanceMinAgeMinutes: 0 })
  if (!result.balance) throw new Error("La banque n'a pas donné de solde")
  if (result.balance.skip_reason === 'stale') {
    const d = String(result.balance.bank_updated_at).slice(0, 10)
    throw new Error(`La banque ne livre plus rien depuis le ${d} — refaire la connexion sur la page Connecteurs`)
  }
  return { woke, balance: result.balance.balance, entry_id: result.balance.entry_id, inserted: result.inserted }
}

// ── Passage planifié ─────────────────────────────────────────────────────────
// Le webhook Plaid est le chemin rapide, mais c'est le SEUL qui existait : une
// signature refusée, un webhook perdu ou une URL injoignable et les
// transactions cessaient d'arriver sans que rien ne le signale. Ce passage
// périodique est le filet — il rattrape tout ce que le webhook a manqué.
export async function scheduledPlaidSync() {
  const items = listItems()
  const results = []
  for (const item of items) {
    try {
      const r = await syncPlaidItem(item.itemId, 'scheduled')
      results.push({ item_id: item.itemId, institution: item.institution_name, inserted: r.inserted })
    } catch (e) {
      results.push({ item_id: item.itemId, institution: item.institution_name, error: e.message })
    }
  }
  return results
}

// État de la connexion, par compte ERP mappé : de quand date la dernière
// transaction, combien de lignes viennent de Plaid. Sert au « Simuler » de
// l'automation et à la page Connecteurs — c'est là qu'on voit un compte mappé
// mais vide (curseur avancé avant le mapping : il faut relire l'historique).
export async function plaidSyncStatus({ checkHealth = true } = {}) {
  const items = listItems()
  const out = []
  for (const item of items) {
    for (const acc of item.accounts || []) {
      const row = db.prepare(`
        SELECT a.id, a.name,
          (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id=a.id AND t.dedup_key LIKE 'plaid:%' AND t.deleted_at IS NULL) AS plaid_count,
          (SELECT MAX(txn_date) FROM bank_transactions t WHERE t.account_id=a.id AND t.dedup_key LIKE 'plaid:%' AND t.deleted_at IS NULL) AS last_txn_date
        FROM bank_accounts a WHERE a.plaid_account_id=? AND a.deleted_at IS NULL
      `).get(acc.plaid_account_id)
      if (!row) continue
      out.push({
        item_id: item.itemId,
        institution: item.institution_name,
        account_id: row.id,
        account_name: row.name,
        plaid_account_name: acc.name,
        plaid_count: row.plaid_count,
        last_txn_date: row.last_txn_date,
        // Les deux, jamais l'un seul : sur un compte balayé par la marge, le
        // solde courant frôle zéro sans que rien n'aille mal.
        balance: acc.balance ?? null,
        balance_available: acc.balance_available ?? null,
        balance_at: acc.balance_at || null,
        // Mappé mais aucune transaction : le curseur a avancé avant le mapping.
        empty: row.plaid_count === 0,
      })
    }
  }
  const itemRows = []
  for (const i of items) {
    const row = {
      item_id: i.itemId, institution: i.institution_name,
      last_synced_at: i.last_synced_at || null, last_error: i.last_error || null,
    }
    // La santé vue de chez Plaid : c'est elle qui dit si la BANQUE répond
    // encore. Un échec ici ne doit pas priver l'écran du reste de l'état.
    if (checkHealth) {
      try {
        Object.assign(row, await itemHealth(i.itemId))
      } catch (e) {
        row.health_error = e?.response?.data?.error_message || e.message
      }
    }
    itemRows.push(row)
  }
  return { items: itemRows, accounts: out }
}

// Solde connu de la banque pour un compte ERP, tel que lu au dernier sync.
// Sur une carte de crédit, `current` EST le montant dû et `available` la place
// qui reste — les deux répondent directement à « la carte a-t-elle encore de
// la place ? », sans passer par une estimation.
export function plaidBalanceFor(bankAccountId) {
  const acc = db.prepare('SELECT plaid_account_id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(bankAccountId)
  if (!acc?.plaid_account_id) return null
  for (const item of listItems()) {
    const hit = (item.accounts || []).find(a => a.plaid_account_id === acc.plaid_account_id)
    if (!hit || hit.balance == null) continue
    return { current: hit.balance, available: hit.balance_available ?? null, read_at: hit.balance_at || null }
  }
  return null
}

// ── Doublons Plaid × TRX_Orisha ──────────────────────────────────────────────
// Avant que TRX_Orisha ne soit coupé pour les comptes Plaid (bankTrxSheet.js),
// les deux sources ont alimenté les mêmes comptes avec des clés de dédup
// étrangères l'une à l'autre : chaque mouvement existe deux fois. On garde la
// ligne Plaid (clé stable, libellé du commerçant) et on lui fait hériter de
// tout ce que la ligne du fichier portait — statut, lien QuickBooks,
// appariement, commentaire — avant de retirer cette dernière.
const STATUS_RANK = { a_traiter: 0, ignore: 1, facture_recue: 2, comptabilise: 3, rapproche: 4 }

// Appariement 1-1 : deux mouvements identiques le même jour sont légitimes
// (deux virements du même montant), chacun doit trouver SA jumelle — jamais
// une ligne Plaid consommée deux fois.
export function pairDuplicates(plaidRows, sheetRows) {
  const byKey = new Map()
  for (const p of plaidRows) {
    const k = `${p.txn_date}|${p.amount.toFixed(2)}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(p)
  }
  const pairs = []
  for (const s of sheetRows) {
    const k = `${s.txn_date}|${s.amount.toFixed(2)}`
    const bucket = byKey.get(k)
    if (bucket && bucket.length) pairs.push({ sheet: s, plaid: bucket.shift() })
  }
  return pairs
}

export function mergeSheetDuplicates(accountId, { apply = false } = {}) {
  const account = db.prepare('SELECT id, name, plaid_account_id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.plaid_account_id) return { account: account.name, pairs: [], merged: 0, skipped: 'compte non branché à Plaid' }

  const rows = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
    ORDER BY txn_date, created_at
  `).all(accountId)
  const plaidRows = rows.filter(r => r.dedup_key.startsWith('plaid:'))
  const sheetRows = rows.filter(r => !r.dedup_key.startsWith('plaid:'))
  const pairs = pairDuplicates(plaidRows, sheetRows)

  const plan = pairs.map(({ sheet, plaid }) => {
    const inherit = {}
    if ((STATUS_RANK[sheet.status] ?? -1) > (STATUS_RANK[plaid.status] ?? -1)) inherit.status = sheet.status
    for (const f of ['qb_txn_type', 'qb_txn_id', 'matched_type', 'matched_id', 'match_method', 'match_confidence',
      'reconciled_at', 'reconciled_by', 'comment', 'sheet_color', 'qb_match_method', 'qb_match_delta',
      'qb_match_account', 'qb_match_rate', 'transfer_txn_id', 'transfer_amount']) {
      if (plaid[f] == null && sheet[f] != null) inherit[f] = sheet[f]
    }
    if (!plaid.details && sheet.details) inherit.details = sheet.details
    return { sheet_id: sheet.id, plaid_id: plaid.id, txn_date: sheet.txn_date, amount: sheet.amount,
      label: sheet.details || sheet.description, inherit }
  })

  if (!apply) return { account: account.name, pairs: plan, merged: 0 }

  const tx = db.transaction(() => {
    for (const p of plan) {
      const keys = Object.keys(p.inherit)
      if (keys.length) {
        db.prepare(`UPDATE bank_transactions SET ${keys.map(k => `${k}=?`).join(', ')},
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(...keys.map(k => p.inherit[k]), p.plaid_id)
      }
      db.prepare(`UPDATE bank_transactions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        comment=COALESCE(comment,'') || ' [fusionnée dans la ligne Plaid]' WHERE id=?`).run(p.sheet_id)
    }
  })
  tx()
  return { account: account.name, pairs: plan, merged: plan.length }
}

// Compteur pour l'UI : combien de doublons restent sur ce compte (0 = rien à
// proposer, la bannière disparaît).
export function countSheetDuplicates(accountId) {
  const account = db.prepare('SELECT plaid_account_id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account?.plaid_account_id) return 0
  const rows = db.prepare('SELECT id, txn_date, amount, dedup_key FROM bank_transactions WHERE account_id=? AND deleted_at IS NULL ORDER BY txn_date, created_at').all(accountId)
  return pairDuplicates(
    rows.filter(r => r.dedup_key.startsWith('plaid:')),
    rows.filter(r => !r.dedup_key.startsWith('plaid:'))
  ).length
}
