// Grand livre Boréal : preuve d'égalité avec QBO (Charles, 2026-10-15, tranche 3/4).
//
// Pour chaque fin de mois, la balance de vérification calculée depuis gl_lines
// est mise à côté du rapport TrialBalance de QBO (lecture seule), compte par
// compte. Rien n'est corrigé : un écart est consigné tel quel.
//
// Le rapport QBO est un « au <end_date> » (start_date ignoré, vérifié le
// 2026-10-17) : bilan depuis l'origine, résultats depuis le début de l'exercice
// qui contient la date ; les résultats des exercices antérieurs sont dans les
// bénéfices non répartis. On calcule la même chose côté Boréal.

import db from '../db/database.js'
import { qbGet, getQbRealmIdSync, qbEntityUrl } from '../connectors/quickbooks.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { accountResolver, monthBounds, monthsBetween, glImportRunning, syncGlDirtyMonths } from './glMirror.js'

export const GL_RECON_AUTOMATION_ID = 'sys_gl_reconciliation'

const cents = (v) => Math.round(Number(v || 0) * 100) / 100
const pad = (n) => String(n).padStart(2, '0')
const PNL = new Set(['Revenue', 'Expense'])

// ── Exercice ───────────────────────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']
let fiscalStartCache = null

/** 'April' | 'Avril' | 4 → 4 (null si illisible). Pure. */
export function monthNumber(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n
  const s = String(v).trim().toLowerCase()
  const fr = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
  const i = MONTHS.indexOf(s) >= 0 ? MONTHS.indexOf(s) : fr.indexOf(s)
  return i >= 0 ? i + 1 : null
}

/** Mois de début d'exercice lu chez QBO (CompanyInfo, sinon Preferences). */
export async function loadFiscalStartMonth() {
  if (fiscalStartCache) return fiscalStartCache
  let m = null
  try { m = monthNumber((await qbGet(`/companyinfo/${getQbRealmIdSync()}`))?.CompanyInfo?.FiscalYearStartMonth) } catch {}
  if (!m) {
    try { m = monthNumber((await qbGet('/preferences'))?.Preferences?.AccountingInfoPrefs?.FirstMonthOfFiscalYear) } catch {}
  }
  if (!m) throw new Error("Début d'exercice introuvable dans QuickBooks")
  fiscalStartCache = m
  return m
}

/** Premier jour de l'exercice qui contient `date`. Pure. */
export function fiscalStartOf(date, startMonth) {
  const [y, m] = String(date).split('-').map(Number)
  return `${m >= startMonth ? y : y - 1}-${pad(startMonth)}-01`
}

// ── Balance QBO ────────────────────────────────────────────────────────────

/**
 * Rapport TrialBalance (JSON) → [{ id, label, balance }] où balance = débit −
 * crédit. Lignes sans compte (TOTAL) ignorées. Pure.
 */
export function parseTrialBalance(report) {
  const out = []
  const walk = (rows) => {
    for (const r of rows || []) {
      const cd = r.ColData
      if (cd && String(cd[0]?.value ?? '').trim()) {
        out.push({
          id: String(cd[0]?.id ?? '').trim() || null,
          label: String(cd[0].value).trim(),
          balance: cents(Number(cd[1]?.value || 0) - Number(cd[2]?.value || 0)),
        })
      }
      if (r.Rows?.Row) walk(r.Rows.Row)
    }
  }
  walk(report?.Rows?.Row)
  return out
}

// ── Balance Boréal ─────────────────────────────────────────────────────────

/**
 * Balance de vérification locale au `asOf` : Map(id → débit − crédit), compte
 * par compte (sans les sous-comptes, comme le rapport QBO).
 */
export function localTrialBalance(asOf, startMonth) {
  const fy = fiscalStartOf(asOf, startMonth)
  const accounts = new Map(db.prepare(`SELECT qb_id, classification, account_sub_type FROM gl_accounts`).all().map(a => [a.qb_id, a]))
  const rows = db.prepare(`
    SELECT l.account_qb_id AS id,
      SUM(l.debit - l.credit) AS life,
      SUM(CASE WHEN e.txn_date >= ? THEN l.debit - l.credit ELSE 0 END) AS fy
    FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
    WHERE e.txn_date <= ? AND l.account_qb_id IS NOT NULL
    GROUP BY l.account_qb_id
  `).all(fy, asOf)
  const out = new Map()
  let priorPnl = 0
  for (const r of rows) {
    const pnl = PNL.has(accounts.get(r.id)?.classification)
    if (pnl) priorPnl += (r.life || 0) - (r.fy || 0)
    out.set(r.id, (pnl ? r.fy : r.life) || 0)
  }
  // Résultats des exercices clos → bénéfices non répartis (clôture implicite de QBO).
  const re = [...accounts.values()].find(a => a.account_sub_type === 'RetainedEarnings')
  if (re && Math.abs(priorPnl) > 0.001) out.set(re.qb_id, (out.get(re.qb_id) || 0) + priorPnl)
  for (const [k, v] of out) out.set(k, cents(v))
  return out
}

/** Rapprochement compte par compte. Pure. */
export function compareBalances(local, qbo, labels = new Map()) {
  const ids = new Set([...local.keys(), ...qbo.keys()])
  const rows = []
  for (const id of ids) {
    const b = cents(local.get(id) || 0)
    const q = cents(qbo.get(id) || 0)
    if (!b && !q) continue
    rows.push({ account_qb_id: id, account_label: labels.get(id) || null, boreal_balance: b, qbo_balance: q, diff: cents(b - q) })
  }
  return rows
}

// ── Vérification d'un mois ─────────────────────────────────────────────────

export async function checkGlMonth(ym, { startMonth, resolve } = {}) {
  const { end } = monthBounds(ym)
  const now = new Date().toISOString()
  const sm = startMonth || await loadFiscalStartMonth()
  try {
    const report = await qbGet(`/reports/TrialBalance?start_date=${end}&end_date=${end}`)
    const res = resolve || accountResolver()
    const labels = new Map()
    const qbo = new Map()
    const unresolved = []
    for (const r of parseTrialBalance(report)) {
      const id = res({ account_qb_id: r.id, account_label: r.label })
      if (!id) { unresolved.push(r.label); continue }
      labels.set(id, r.label)
      qbo.set(id, cents((qbo.get(id) || 0) + r.balance))
    }
    const names = new Map(db.prepare(`SELECT qb_id, acct_num, fully_qualified_name FROM gl_accounts`).all()
      .map(a => [a.qb_id, [a.acct_num, a.fully_qualified_name].filter(Boolean).join(' ')]))
    for (const [id, n] of names) if (!labels.has(id)) labels.set(id, n)
    const rows = compareBalances(localTrialBalance(end, sm), qbo, labels)
    const bad = rows.filter(r => r.diff)
    const ins = db.prepare(`
      INSERT INTO gl_reconciliation_checks (month, account_qb_id, account_label, boreal_balance, qbo_balance, diff, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    db.transaction(() => {
      db.prepare(`DELETE FROM gl_reconciliation_checks WHERE month = ?`).run(ym)
      for (const r of rows) ins.run(ym, r.account_qb_id, r.account_label, r.boreal_balance, r.qbo_balance, r.diff, now)
      saveMonth(ym, end, { accounts: rows.length, mismatches: bad.length,
        total_diff: cents(bad.reduce((s, r) => s + Math.abs(r.diff), 0)),
        error: unresolved.length ? `Comptes QBO introuvables : ${unresolved.join(', ')}` : null }, now)
    })()
    return { month: ym, accounts: rows.length, mismatches: bad.length, unresolved }
  } catch (err) {
    saveMonth(ym, end, { error: err.message }, now)
    throw err
  }
}

function saveMonth(ym, asOf, f, now) {
  db.prepare(`
    INSERT INTO gl_reconciliation_months (month, as_of, accounts, mismatches, total_diff, error, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET as_of = excluded.as_of,
      accounts = CASE WHEN excluded.accounts IS NULL THEN accounts ELSE excluded.accounts END,
      mismatches = CASE WHEN excluded.mismatches IS NULL THEN mismatches ELSE excluded.mismatches END,
      total_diff = CASE WHEN excluded.total_diff IS NULL THEN total_diff ELSE excluded.total_diff END,
      error = excluded.error, checked_at = excluded.checked_at
  `).run(ym, asOf, f.accounts ?? 0, f.mismatches ?? 0, f.total_diff ?? 0, f.error ?? null, now)
}

// ── Passage complet (exercice en cours + précédent) ────────────────────────

let checking = false

export async function runGlReconciliation({ trigger = 'planifie', force = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!force && !isSystemAutomationActive(GL_RECON_AUTOMATION_ID)) return { skipped: 'inactive' }
  if (checking) return { skipped: 'en cours' }
  if (glImportRunning()) return { skipped: 'import du grand livre en cours' }
  checking = true
  const t0 = Date.now()
  try {
    // Mois modifiés dans QBO depuis le dernier import : à jour avant de comparer.
    try { await syncGlDirtyMonths({ trigger: 'comparaison' }) } catch {}
    const sm = await loadFiscalStartMonth()
    const curFy = fiscalStartOf(today, sm)
    const from = `${Number(curFy.slice(0, 4)) - 1}${curFy.slice(4, 7)}`
    const resolve = accountResolver()
    const results = []
    for (const ym of monthsBetween(from, today)) {
      try { results.push(await checkGlMonth(ym, { startMonth: sm, resolve })) }
      catch (err) { results.push({ month: ym, error: err.message }) }
    }
    const failed = results.filter(r => r.error)
    const bad = results.filter(r => r.mismatches)
    const summary = `${results.length} mois comparés (${from} →)` +
      (bad.length ? ` · écarts : ${bad.map(r => `${r.month} (${r.mismatches})`).join(', ')}` : ' · tous identiques') +
      (failed.length ? ` · échecs : ${failed.map(r => r.month).join(', ')}` : '')
    logSystemRun(GL_RECON_AUTOMATION_ID, {
      status: failed.length ? 'error' : 'success', result: summary,
      error: failed.length ? failed.map(f => `${f.month} : ${f.error}`).join('\n') : null,
      duration_ms: Date.now() - t0, triggerData: { trigger, from },
    })
    return { results, summary }
  } catch (err) {
    logSystemRun(GL_RECON_AUTOMATION_ID, { status: 'error', error: err.message, duration_ms: Date.now() - t0, triggerData: { trigger } })
    throw err
  } finally {
    checking = false
  }
}

export function glReconciliationRunning() { return checking }

// ── Lecture pour l'écran ───────────────────────────────────────────────────

export function reconciliationMonths() {
  return db.prepare(`SELECT * FROM gl_reconciliation_months ORDER BY month DESC`).all()
}

export function reconciliationAccounts(ym) {
  return db.prepare(`
    SELECT c.*, a.classification, a.account_type
    FROM gl_reconciliation_checks c LEFT JOIN gl_accounts a ON a.qb_id = c.account_qb_id
    WHERE c.month = ? ORDER BY ABS(c.diff) DESC, c.account_label
  `).all(ym)
}

// Type de gl_entries → page de QBO (qbEntityUrl). Un chèque est un Purchase
// affiché sur sa propre page.
const QB_PAGES = {
  Invoice: 'invoice', Payment: 'recvpayment', SalesReceipt: 'salesreceipt', CreditMemo: 'creditmemo',
  RefundReceipt: 'refundreceipt', Purchase: 'expense', VendorCredit: 'vendorcredit', Bill: 'bill',
  BillPayment: 'billpayment', Deposit: 'deposit', Transfer: 'transfer', JournalEntry: 'journal',
}
export function qbPageOf(type, label) {
  if (type === 'Purchase' && /^chèque/i.test(String(label || ''))) return 'check'
  return QB_PAGES[type] || null
}

export function accountMonthLines(ym, accountId) {
  const { start, end } = monthBounds(ym)
  return db.prepare(`
    SELECT l.id, e.id AS entry_id, e.txn_date, e.txn_type, e.txn_label, e.qb_txn_id, e.doc_number,
      COALESCE(l.name, e.name) AS name, COALESCE(l.memo, e.memo) AS memo, l.debit, l.credit
    FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
    WHERE l.account_qb_id = ? AND e.txn_date BETWEEN ? AND ?
    ORDER BY e.txn_date, e.id, l.line_no
  `).all(accountId, start, end).map(r => {
    const page = qbPageOf(r.txn_type, r.txn_label)
    return { ...r, qb_url: page ? qbEntityUrl(page, r.qb_txn_id) : null }
  })
}
