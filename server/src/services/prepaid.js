// Comptes prépayés.
//
// Volet 1 — soldes fournisseurs prépayés (remplace le fichier Twilio_Suivi) :
// ledger par fournisseur alimenté par détection des transactions QuickBooks
// (Purchase/Bill/VendorCredit du fournisseur). Solde = Σ recharges − Σ factures
// + Σ ajustements ; positif = crédit prépayé chez le fournisseur.
//
// Volet 2 — cédule de continuité des frais payés d'avance #13000 (remplace les
// fichiers FPA_Continuité annuels) : calcul de l'amortissement mensuel par item
// et préparation de l'écriture Dr dépense / Cr 13000 du mois, publiée dans QB
// seulement après approbation dans l'interface.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { qbGet, qbPost, qbEntityUrl } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { logSync } from './syncLog.js'

// Slug d'URL QBO par type de transaction (page d'édition dans l'app QB).
const QB_URL_SLUGS = { Purchase: 'expense', Bill: 'bill', VendorCredit: 'vendorcredit' }

// ── Volet 1 : ledger fournisseurs prépayés ──────────────────────────────────

// Signe d'une entrée dans le solde : recharge = paiement au fournisseur (le
// crédit prépayé monte), facture = consommation (il descend), ajustement signé.
export function entrySign(entry) {
  if (entry.type === 'recharge') return Math.abs(entry.amount)
  if (entry.type === 'facture') return -Math.abs(entry.amount)
  return entry.amount
}

// Entrées d'un compte, chronologiques, avec solde courant cumulé.
export function ledgerEntries(accountId) {
  const rows = db.prepare(`
    SELECT * FROM prepaid_ledger_entries
    WHERE account_id = ? AND deleted_at IS NULL
    ORDER BY entry_date, created_at
  `).all(accountId)
  let balance = 0
  for (const r of rows) {
    if (!r.excluded) balance = Math.round((balance + entrySign(r)) * 100) / 100
    r.running_balance = balance
    r.qb_url = r.qb_txn_id && QB_URL_SLUGS[r.qb_txn_type]
      ? qbEntityUrl(QB_URL_SLUGS[r.qb_txn_type], r.qb_txn_id)
      : null
  }
  return rows
}

export function ledgerBalance(accountId) {
  const rows = ledgerEntries(accountId)
  return rows.length ? rows[rows.length - 1].running_balance : 0
}

// Classification d'un Purchase QB détecté pour le fournisseur du compte.
// La convention comptable propre : la recharge est une dépense payée de la carte
// dont la catégorie est le compte d'actif prépayé (Dr actif / Cr carte) ; la
// facture mensuelle est une dépense payée DEPUIS le compte d'actif prépayé
// (Dr dépense / Cr actif). Quand le compte d'actif est configuré on classe par
// sa position dans la transaction ; sinon on retombe sur le type de document.
export function classifyQbTxn(txnType, txn, assetAccountId = null) {
  if (txnType === 'Bill') return 'facture'
  if (txnType === 'VendorCredit') return 'ajustement'
  if (txnType === 'Purchase') {
    if (assetAccountId) {
      const paymentAcct = txn.AccountRef?.value ? String(txn.AccountRef.value) : null
      if (paymentAcct === String(assetAccountId)) return 'facture'
      const lines = Array.isArray(txn.Line) ? txn.Line : []
      const hitsAsset = lines.some(l =>
        String(l.AccountBasedExpenseLineDetail?.AccountRef?.value || '') === String(assetAccountId))
      if (hitsAsset) return 'recharge'
    }
    return 'recharge'
  }
  return 'ajustement'
}

async function resolveQbVendorId(account) {
  if (account.qb_vendor_id) return account.qb_vendor_id
  const name = (account.qb_vendor_name || account.vendor || '').replace(/'/g, "\\'")
  const q = encodeURIComponent(`SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${name}'`)
  const data = await qbGet(`/query?query=${q}`)
  const v = (data.QueryResponse?.Vendor || [])[0]
  if (!v) return null
  db.prepare(`UPDATE prepaid_accounts SET qb_vendor_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(String(v.Id), account.id)
  return String(v.Id)
}

async function queryTxnsSince(entity, sinceDate) {
  const all = []
  let startPos = 1
  const pageSize = 500
  while (true) {
    const q = encodeURIComponent(
      `SELECT * FROM ${entity} WHERE TxnDate >= '${sinceDate}' ORDERBY TxnDate MAXRESULTS ${pageSize} STARTPOSITION ${startPos}`)
    const data = await qbGet(`/query?query=${q}`)
    const rows = data.QueryResponse?.[entity] || []
    all.push(...rows)
    if (rows.length < pageSize) break
    startPos += pageSize
  }
  return all
}

// Transactions QB du fournisseur d'un compte, normalisées au format ledger
// (montant tel que stocké : positif, sauf VendorCredit négatif).
async function fetchVendorQbTxns(account, vendorId, assetAccountId, since) {
  const out = []
  for (const [entity, vendorOf] of [
    ['Purchase', t => t.EntityRef?.value],
    ['Bill', t => t.VendorRef?.value],
    ['VendorCredit', t => t.VendorRef?.value],
  ]) {
    const txns = await queryTxnsSince(entity, since)
    for (const t of txns) {
      if (String(vendorOf(t) || '') !== String(vendorId)) continue
      const amount = Math.abs(Number(t.TotalAmt) || 0)
      if (!amount) continue
      out.push({
        qb_txn_type: entity,
        qb_txn_id: String(t.Id),
        entry_date: t.TxnDate,
        type: classifyQbTxn(entity, t, assetAccountId),
        amount: entity === 'VendorCredit' ? -amount : amount,
        description: t.PrivateNote || t.Memo || `${entity} QB #${t.DocNumber || t.Id}`,
      })
    }
  }
  return out
}

// Détection des transactions QB d'un compte prépayé. Idempotent : dédup par
// (account_id, qb_txn_type, qb_txn_id) via index unique — une transaction déjà
// importée est ignorée, même si son type a été reclassé à la main depuis.
export async function syncPrepaidAccountFromQB(accountId, trigger = 'manual') {
  const t0 = Date.now()
  const account = db.prepare('SELECT * FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte prépayé introuvable')
  try {
    const vendorId = await resolveQbVendorId(account)
    if (!vendorId) throw new Error(`Fournisseur QB introuvable : « ${account.qb_vendor_name || account.vendor} »`)
    const assetAccountId = account.qb_asset_acctnum
      ? await resolveAccountByAcctNum(account.qb_asset_acctnum)
      : null

    // Fenêtre : depuis la dernière entrée QB connue (avec 30 jours de marge pour
    // les transactions antidatées), sinon depuis sync_start_date.
    const last = db.prepare(`
      SELECT MAX(entry_date) AS d FROM prepaid_ledger_entries
      WHERE account_id = ? AND source = 'qb' AND deleted_at IS NULL
    `).get(accountId)
    let since = account.sync_start_date || '2000-01-01'
    if (last?.d) {
      const back = new Date(`${last.d}T12:00:00Z`)
      back.setUTCDate(back.getUTCDate() - 30)
      const backIso = back.toISOString().slice(0, 10)
      if (backIso > since) since = backIso
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO prepaid_ledger_entries
        (id, account_id, entry_date, type, amount, description, source, qb_txn_type, qb_txn_id)
      VALUES (?,?,?,?,?,?,'qb',?,?)
    `)
    let imported = 0
    for (const t of await fetchVendorQbTxns(account, vendorId, assetAccountId, since)) {
      const r = insert.run(randomUUID(), accountId, t.entry_date, t.type,
        t.amount, t.description, t.qb_txn_type, t.qb_txn_id)
      imported += r.changes
    }
    logSync('prepaid_ledger', trigger, { status: 'success', modified: imported, durationMs: Date.now() - t0 })
    return { imported, since }
  } catch (e) {
    logSync('prepaid_ledger', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    throw e
  }
}

// Diff pur ledger ERP (entrées source='qb') vs transactions QB — testable sans
// API. Le type n'est PAS comparé : un reclassement manuel est légitime.
export function diffLedgerVsQb(erpEntries, qbTxns) {
  const key = t => `${t.qb_txn_type}:${t.qb_txn_id}`
  const erpByKey = new Map(erpEntries.map(e => [key(e), e]))
  const qbKeys = new Set(qbTxns.map(key))
  const missing = []; const mismatched = []
  let matched = 0
  for (const t of qbTxns) {
    const e = erpByKey.get(key(t))
    if (!e) { missing.push(t); continue }
    const amountDiff = Math.abs(Math.abs(e.amount) - Math.abs(t.amount)) > 0.005
    const dateDiff = e.entry_date !== t.entry_date
    if (amountDiff || dateDiff) {
      mismatched.push({ entry: e, qb: t, amount_differs: amountDiff, date_differs: dateDiff })
    } else {
      matched++
    }
  }
  const orphaned = erpEntries.filter(e => !qbKeys.has(key(e)))
  return { matched, missing, mismatched, orphaned }
}

// Audit de complétude : recompare TOUT le ledger (depuis sync_start_date, sans
// la fenêtre incrémentale de 30 jours du sync) aux transactions QB réelles.
// Détecte : transactions QB absentes du ledger (ex. antidatées au-delà de la
// fenêtre), montants/dates modifiés dans QB après import, entrées ERP dont la
// transaction QB a été supprimée/annulée. `apply` corrige : importe les
// manquantes, réaligne montants/dates, exclut les orphelines (réversible).
export async function auditPrepaidAccountAgainstQB(accountId, { apply = false, trigger = 'manual' } = {}) {
  const t0 = Date.now()
  const account = db.prepare('SELECT * FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte prépayé introuvable')
  try {
    const vendorId = await resolveQbVendorId(account)
    if (!vendorId) throw new Error(`Fournisseur QB introuvable : « ${account.qb_vendor_name || account.vendor} »`)
    const assetAccountId = account.qb_asset_acctnum
      ? await resolveAccountByAcctNum(account.qb_asset_acctnum)
      : null
    const since = account.sync_start_date || '2000-01-01'
    const qbTxns = await fetchVendorQbTxns(account, vendorId, assetAccountId, since)
    const erpEntries = db.prepare(`
      SELECT * FROM prepaid_ledger_entries
      WHERE account_id = ? AND source = 'qb' AND deleted_at IS NULL AND entry_date >= ?
    `).all(accountId, since)
    const diff = diffLedgerVsQb(erpEntries, qbTxns)

    let fixed = 0
    if (apply) {
      const applyAll = db.transaction(() => {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO prepaid_ledger_entries
            (id, account_id, entry_date, type, amount, description, source, qb_txn_type, qb_txn_id)
          VALUES (?,?,?,?,?,?,'qb',?,?)
        `)
        for (const t of diff.missing) {
          fixed += insert.run(randomUUID(), accountId, t.entry_date, t.type,
            t.amount, t.description, t.qb_txn_type, t.qb_txn_id).changes
        }
        // Réalignement : montant/date depuis QB, type conservé (reclassement
        // manuel légitime), signe conservé pour les ajustements négatifs.
        for (const m of diff.mismatched) {
          const newAmount = m.entry.amount < 0 ? -Math.abs(m.qb.amount) : Math.abs(m.qb.amount)
          fixed += db.prepare(`
            UPDATE prepaid_ledger_entries
            SET amount = ?, entry_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).run(newAmount, m.qb.entry_date, m.entry.id).changes
        }
        for (const e of diff.orphaned) {
          fixed += db.prepare(`
            UPDATE prepaid_ledger_entries
            SET excluded = 1,
                description = COALESCE(description, '') || ' [introuvable dans QB — exclue par audit]',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND excluded = 0
          `).run(e.id).changes
        }
      })
      applyAll()
    }

    logSync('prepaid_audit', trigger, { status: 'success', modified: fixed, durationMs: Date.now() - t0 })
    return { since, qb_total: qbTxns.length, ...diff, applied: apply, fixed }
  } catch (e) {
    logSync('prepaid_audit', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    throw e
  }
}

export async function syncAllPrepaidAccountsFromQB(trigger = 'scheduled') {
  const accounts = db.prepare(`SELECT id FROM prepaid_accounts WHERE active = 1 AND deleted_at IS NULL`).all()
  const out = []
  for (const a of accounts) {
    try {
      // Audit correcteur plutôt que simple détection : importe aussi les
      // transactions antidatées hors fenêtre, réaligne les montants modifiés
      // dans QB et exclut les entrées dont la transaction QB a été supprimée.
      out.push({ id: a.id, ...(await auditPrepaidAccountAgainstQB(a.id, { apply: true, trigger })) })
    } catch (e) {
      out.push({ id: a.id, error: e.message })
    }
  }
  return out
}

// Solde réel chez le fournisseur (vérification croisée). Twilio : API Balance —
// crédit prépayé restant sur le compte, à comparer au solde théorique du ledger.
export async function fetchProviderBalance(account) {
  if (account.balance_provider !== 'twilio') return { error: 'Aucun fournisseur de solde configuré' }
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return { error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN non configurés dans server/.env' }
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
  })
  if (!resp.ok) return { error: `API Twilio ${resp.status}: ${(await resp.text()).slice(0, 200)}` }
  const data = await resp.json()
  return { balance: Number(data.balance), currency: data.currency, fetched_at: new Date().toISOString() }
}

// ── Volet 2 : cédule FPA ────────────────────────────────────────────────────

const monthKey = d => d.toISOString().slice(0, 7)
const daysInMonth = (y, m1) => new Date(Date.UTC(y, m1, 0)).getUTCDate()

// Cédule calculée d'un item (méthode prorata_jours) : chaque mois couvert reçoit
// montant × jours couverts du mois / jours totaux, arrondi au cent — sauf le
// dernier mois qui absorbe le résidu (convention du fichier FPA_Continuité :
// ex. Intact 3 835 $ sur 223 jours → 7 × 515,91 + 223,63).
export function computeSchedule(expense) {
  if (expense.method !== 'prorata_jours' || !expense.amort_start || !expense.amort_end) return []
  const start = new Date(`${expense.amort_start}T00:00:00Z`)
  const end = new Date(`${expense.amort_end}T00:00:00Z`)
  if (!(start <= end)) return []
  const totalDays = Math.round((end - start) / 86400000) + 1
  const months = []
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur <= end) {
    const y = cur.getUTCFullYear(); const m = cur.getUTCMonth()
    const mStart = new Date(Date.UTC(y, m, 1))
    const mEnd = new Date(Date.UTC(y, m, daysInMonth(y, m + 1)))
    const from = start > mStart ? start : mStart
    const to = end < mEnd ? end : mEnd
    const days = Math.round((to - from) / 86400000) + 1
    months.push({ month: monthKey(mStart), days })
    cur = new Date(Date.UTC(y, m + 1, 1))
  }
  let allocated = 0
  return months.map((m, i) => {
    let amount
    if (i === months.length - 1) {
      amount = Math.round((expense.amount - allocated) * 100) / 100
    } else {
      amount = Math.round((expense.amount * m.days / totalDays) * 100) / 100
      allocated = Math.round((allocated + amount) * 100) / 100
    }
    return { month: m.month, amount }
  })
}

// Cédule effective : cédule calculée, écrasée mois par mois par les lignes
// matérialisées (import historique, override manuel, mois publiés).
export function effectiveSchedule(expense) {
  const materialized = db.prepare(`
    SELECT * FROM prepaid_amortizations WHERE expense_id = ? AND deleted_at IS NULL ORDER BY month
  `).all(expense.id)
  const byMonth = new Map(materialized.map(r => [r.month, r]))
  const schedule = new Map()
  for (const s of computeSchedule(expense)) {
    schedule.set(s.month, { month: s.month, amount: s.amount, source: 'auto', qb_je_id: null, pushed_at: null, id: null })
  }
  for (const r of byMonth.values()) {
    schedule.set(r.month, { month: r.month, amount: r.amount, source: r.source, qb_je_id: r.qb_je_id, pushed_at: r.pushed_at, id: r.id })
  }
  const out = [...schedule.values()].sort((a, b) => a.month.localeCompare(b.month))
  // Prorata : si le dernier mois est encore calculé (non matérialisé), il
  // absorbe le résidu de la cédule EFFECTIVE — les mois historiques importés
  // (arrondis différemment par la comptable) ne doivent pas laisser un solde
  // de fermeture non nul.
  if (expense.method === 'prorata_jours' && out.length && out[out.length - 1].source === 'auto') {
    const others = out.slice(0, -1).reduce((s, m) => s + m.amount, 0)
    out[out.length - 1].amount = Math.round((expense.amount - others) * 100) / 100
  }
  return out
}

// Exercice fiscal : avril startYear → mars startYear+1 (le « 26-27 » des fichiers).
export function fiscalMonths(startYear) {
  return Array.from({ length: 12 }, (_, i) => {
    const y = startYear + Math.floor((3 + i) / 12)
    const m = ((3 + i) % 12) + 1
    return `${y}-${String(m).padStart(2, '0')}`
  })
}

// Vue de continuité d'un exercice : solde d'ouverture (montant − amorti avant
// avril), amortissement par mois, solde de fermeture.
export function continuityView(startYear) {
  const months = fiscalMonths(startYear)
  const first = months[0]; const last = months[11]
  const expenses = db.prepare(`SELECT * FROM prepaid_expenses WHERE deleted_at IS NULL ORDER BY payment_date, label`).all()
  const items = []
  for (const e of expenses) {
    const sched = effectiveSchedule(e)
    const before = sched.filter(s => s.month < first).reduce((sum, s) => sum + s.amount, 0)
    const opening = Math.round((e.amount - before) * 100) / 100
    const inYear = sched.filter(s => s.month >= first && s.month <= last)
    // Item soldé avant l'exercice et inactif → ne pollue pas la cédule.
    if (!e.active && opening === 0 && !inYear.length) continue
    const byMonth = Object.fromEntries(inYear.map(s => [s.month, s]))
    const amortized = inYear.reduce((sum, s) => sum + s.amount, 0)
    items.push({
      ...e,
      opening_balance: opening,
      closing_balance: Math.round((opening - amortized) * 100) / 100,
      months: byMonth,
    })
  }
  return { start_year: startYear, months, items }
}

// Écriture du mois : une ligne Dr par item avec un montant ce mois-là, Cr
// regroupés par compte FPA. `publishable` = lignes pas encore poussées.
export function buildFpaMonth(month) {
  const expenses = db.prepare(`SELECT * FROM prepaid_expenses WHERE deleted_at IS NULL`).all()
  const lines = []
  for (const e of expenses) {
    const s = effectiveSchedule(e).find(x => x.month === month)
    if (!s || !s.amount) continue
    lines.push({
      expense_id: e.id, label: e.label, amount: s.amount,
      expense_acctnum: e.expense_acctnum, fpa_acctnum: e.fpa_acctnum || '13000',
      source: s.source, qb_je_id: s.qb_je_id, pushed_at: s.pushed_at,
    })
  }
  const publishable = lines.filter(l => !l.pushed_at)
  return {
    month, lines,
    publishable_total: Math.round(publishable.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    publishable_count: publishable.length,
    missing_accounts: publishable.filter(l => !l.expense_acctnum).map(l => l.label),
  }
}

// Publication de l'écriture du mois dans QB (après approbation utilisateur).
// Marque chaque ligne publiée dans prepaid_amortizations (claim AVANT le POST,
// rollback si le POST échoue — même pattern que postRevenueRecognitionJE).
export async function publishFpaMonth(month, { userId = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const built = buildFpaMonth(month)
  const toPush = built.lines.filter(l => !l.pushed_at)
  if (!toPush.length) throw new Error('Rien à publier pour ce mois')
  if (built.missing_accounts.length) {
    throw new Error(`Compte de dépense manquant sur : ${built.missing_accounts.join(', ')}`)
  }

  // Claim : matérialise les lignes avec pushed_at posé. L'index unique
  // (expense_id, month) fait échouer un double-publish concurrent.
  const now = new Date().toISOString()
  const claimed = []
  const upsert = db.transaction(() => {
    for (const l of toPush) {
      const existing = db.prepare(`
        SELECT id, pushed_at FROM prepaid_amortizations
        WHERE expense_id = ? AND month = ? AND deleted_at IS NULL
      `).get(l.expense_id, month)
      if (existing?.pushed_at) throw new Error(`${l.label} : mois déjà publié`)
      if (existing) {
        db.prepare(`UPDATE prepaid_amortizations SET pushed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, existing.id)
        claimed.push(existing.id)
      } else {
        const id = randomUUID()
        db.prepare(`
          INSERT INTO prepaid_amortizations (id, expense_id, month, amount, source, pushed_at)
          VALUES (?,?,?,?,'auto',?)
        `).run(id, l.expense_id, month, l.amount, now)
        claimed.push(id)
      }
    }
  })
  upsert()

  try {
    const debitLines = []
    const creditByAcct = new Map()
    for (const l of toPush) {
      const acctId = await resolveAccountByAcctNum(l.expense_acctnum)
      if (!acctId) throw new Error(`Compte QB #${l.expense_acctnum} introuvable (${l.label})`)
      debitLines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: l.amount,
        Description: `FPA ${month} — ${l.label}`,
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: acctId } },
      })
      const prev = creditByAcct.get(l.fpa_acctnum) || 0
      creditByAcct.set(l.fpa_acctnum, Math.round((prev + l.amount) * 100) / 100)
    }
    const creditLines = []
    for (const [acctnum, amount] of creditByAcct) {
      const acctId = await resolveAccountByAcctNum(acctnum)
      if (!acctId) throw new Error(`Compte QB #${acctnum} introuvable (FPA)`)
      creditLines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: amount,
        Description: `Imputation FPA ${month}`,
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: acctId } },
      })
    }
    const lastDay = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
    const je = {
      TxnDate: `${month}-${String(lastDay).padStart(2, '0')}`,
      PrivateNote: `Imputation des frais payés d'avance — ${month} (ERP, comptes prépayés)`,
      Line: [...debitLines, ...creditLines],
    }
    const result = await qbPost('/journalentry', je)
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry")
    db.prepare(`UPDATE prepaid_amortizations SET qb_je_id = ?, updated_at = ? WHERE id IN (${claimed.map(() => '?').join(',')})`)
      .run(String(jeId), new Date().toISOString(), ...claimed)
    logSync('prepaid_fpa', 'manual', { status: 'success', modified: toPush.length })
    return { qb_je_id: String(jeId), month, lines: toPush.length, total: built.publishable_total, published_by: userId }
  } catch (e) {
    // Rollback du claim : aucune JE n'existe (le POST a échoué avant/pendant),
    // on libère les lignes pour permettre une nouvelle tentative.
    const rollback = db.transaction(() => {
      for (const id of claimed) {
        const row = db.prepare('SELECT source FROM prepaid_amortizations WHERE id = ?').get(id)
        if (row?.source === 'auto') {
          db.prepare('DELETE FROM prepaid_amortizations WHERE id = ? AND qb_je_id IS NULL').run(id)
        } else {
          db.prepare('UPDATE prepaid_amortizations SET pushed_at = NULL WHERE id = ? AND qb_je_id IS NULL').run(id)
        }
      }
    })
    rollback()
    logSync('prepaid_fpa', 'manual', { status: 'error', error: e.message })
    throw e
  }
}
