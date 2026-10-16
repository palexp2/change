// Grand livre « miroir » de QuickBooks (Charles, 2026-10-15, tranche 1/4).
//
// Boréal n'avait pas de grand livre propre : il faut savoir, sans demander à
// QBO, quel montant a été passé à quel compte et quand. On recopie donc, en
// LECTURE seule (qbGet), toutes les lignes débit/crédit de QBO, mois par mois,
// depuis le rapport JournalReport — le seul qui donne chaque transaction avec
// toutes ses lignes, tous types confondus (factures clients, taxes, comptes
// clients/fournisseurs inclus). Le rapport GeneralLedger est écarté : son filtre
// de compte n'est pas fiable (voir services/qbAccountLedger.js).
//
// Format réel du rapport (vérifié sur septembre 2026) : une liste à plat de
//   - une ligne d'en-tête par transaction (date, type + id, n°, nom, mémo,
//     compte + id, débit, crédit),
//   - des lignes de suite datées « 0-00-00 » portant le même id,
//   - une Section « Summary » = total de la transaction,
//   - une ligne entièrement vide de séparation,
// et une Summary finale « TOTAL ». Montants en devise de base (CAD).
//
// Import idempotent : chaque mois est remplacé en bloc dans UNE transaction
// SQLite. Une transaction déséquilibrée est consignée dans gl_import_runs.error,
// jamais corrigée.

import db from '../db/database.js'
import { qbGet, getQbRealmIdSync } from '../connectors/quickbooks.js'

// Libellés (QBO en français) → entité de l'API. L'id d'une transaction n'est
// unique que dans son entité : deux libellés d'une même entité (chèque /
// dépense / remboursement carte → Purchase) partagent donc un espace d'ids.
// Un libellé inconnu garde son libellé brut comme type.
const TXN_TYPES = {
  'Facture': 'Invoice',
  'Paiement': 'Payment',
  'Reçu de vente': 'SalesReceipt',
  'Note de crédit': 'CreditMemo',
  'Remboursement': 'RefundReceipt',
  'Reçu de remboursement': 'RefundReceipt',
  'Dépense': 'Purchase',
  'Chèque': 'Purchase',
  'Remboursement de carte de crédit': 'Purchase',
  'Crédit de carte de crédit': 'Purchase',
  'Crédit sur carte de crédit': 'Purchase',
  'Dépense de chèque': 'Purchase',
  'Crédit de fournisseur': 'VendorCredit',
  'Paiement par carte de crédit': 'CreditCardPayment',
  'Paiement de la taxe de vente': 'SalesTaxPayment',
  'Rajustement de la taxe de vente': 'TaxAdjustment',
  'Facture à payer': 'Bill',
  'Crédit fournisseur': 'VendorCredit',
  'Paiement de factures (chèque)': 'BillPayment',
  'Paiement de factures (carte de crédit)': 'BillPayment',
  'Dépôt': 'Deposit',
  'Virement': 'Transfer',
  'Écriture de journal': 'JournalEntry',
  'Ajustement de quantité de stock': 'InventoryQtyAdjust',
  'Paiement de taxe de vente': 'SalesTaxPayment',
  'Paiement de taxes': 'SalesTaxPayment',
}

export function txnTypeOf(label) {
  const l = String(label || '').trim()
  return TXN_TYPES[l] || l || 'Inconnu'
}

const cents = (v) => Math.round(Number(v || 0) * 100) / 100
const amount = (v) => {
  const s = String(v ?? '').trim()
  return s ? cents(Number(s)) : 0
}

/**
 * Lit un JournalReport QBO (JSON) → transactions et leurs lignes. Pure : aucun
 * accès DB ni réseau (testée sur une fixture du rapport réel).
 * Retour : { entries: [...], total: { debit, credit } | null, anomalies: [...] }
 */
export function parseJournalReport(report) {
  const cols = (report?.Columns?.Column || []).map(c =>
    (c.MetaData || []).find(m => m.Name === 'ColKey')?.Value)
  const at = (key, fallback) => { const i = cols.indexOf(key); return i >= 0 ? i : fallback }
  const C = {
    date: at('tx_date', 0), type: at('txn_type', 1), doc: at('doc_num', 2),
    name: at('name', 4), memo: at('memo', 5), acctNum: at('acct_num_with_extn', 6),
    account: at('account_name', 7), debit: at('debt_home_amt', 8), credit: at('credit_home_amt', 9),
  }

  const entries = []
  const anomalies = []
  let total = null
  let cur = null

  const close = (summary) => {
    if (!cur) return
    if (summary) cur.summary = { debit: amount(summary[C.debit]?.value), credit: amount(summary[C.credit]?.value) }
    entries.push(cur)
    cur = null
  }

  const onData = (cd) => {
    const v = (i) => String(cd[i]?.value ?? '').trim()
    if (cd.every(c => !String(c?.value ?? '').trim())) return
    const date = v(C.date)
    const txnId = String(cd[C.type]?.id ?? '').trim()
    const isHeader = date && date !== '0-00-00'
    if (isHeader) {
      close(null)
      const label = v(C.type)
      const type = txnTypeOf(label)
      cur = {
        id: `${type}:${txnId}`, txn_type: type, txn_label: label, qb_txn_id: txnId,
        txn_date: date, doc_number: v(C.doc) || null, name: v(C.name) || null,
        memo: v(C.memo) || null, lines: [],
      }
    } else if (!cur) {
      anomalies.push(`ligne sans transaction (id ${txnId || '?'})`)
      return
    } else if (txnId && txnId !== cur.qb_txn_id) {
      anomalies.push(`${cur.id} : ligne d'une autre transaction (${txnId})`)
    }
    const accountId = String(cd[C.account]?.id ?? '').trim()
    // Ligne sans compte ni montant (paiement client qui applique un crédit) :
    // aucun effet sur le grand livre.
    if (!accountId && !v(C.account) && !amount(cd[C.debit]?.value) && !amount(cd[C.credit]?.value)) return
    cur.lines.push({
      line_no: cur.lines.length + 1,
      account_qb_id: accountId || null,
      account_label: v(C.account) || null,
      acct_num: v(C.acctNum) || null,
      debit: amount(cd[C.debit]?.value),
      credit: amount(cd[C.credit]?.value),
      memo: v(C.memo) || null,
      name: v(C.name) || null,
    })
  }

  const walk = (rows) => {
    for (const r of rows || []) {
      if (r.ColData) onData(r.ColData)
      if (r.Rows?.Row) walk(r.Rows.Row)
      if (r.Summary?.ColData) {
        const s = r.Summary.ColData
        if (String(s[0]?.value ?? '').trim().toUpperCase() === 'TOTAL' || !cur) {
          close(null)
          total = { debit: amount(s[C.debit]?.value), credit: amount(s[C.credit]?.value) }
        } else close(s)
      }
    }
  }
  walk(report?.Rows?.Row)
  close(null)
  return { entries, total, anomalies }
}

/** Contrôles d'une transaction : équilibre et accord avec le total du rapport. */
export function entryIssues(e) {
  const d = cents(e.lines.reduce((s, l) => s + l.debit, 0))
  const c = cents(e.lines.reduce((s, l) => s + l.credit, 0))
  const out = []
  if (Math.abs(d - c) > 0.01) out.push(`${e.id} (${e.txn_date}) déséquilibrée : débits ${d} ≠ crédits ${c}`)
  if (e.summary && (Math.abs(e.summary.debit - d) > 0.01 || Math.abs(e.summary.credit - c) > 0.01)) {
    out.push(`${e.id} (${e.txn_date}) : lignes ${d}/${c} ≠ total du rapport ${e.summary.debit}/${e.summary.credit}`)
  }
  return out
}

// ── Plan comptable ─────────────────────────────────────────────────────────

/** Recopie tous les comptes QBO, inactifs compris. */
export async function refreshGlAccounts() {
  const all = []
  for (let start = 1; ; start += 1000) {
    const q = `select * from Account where Active in (true,false) startposition ${start} maxresults 1000`
    const page = (await qbGet(`/query?query=${encodeURIComponent(q)}`))?.QueryResponse?.Account || []
    all.push(...page)
    if (page.length < 1000) break
  }
  const now = new Date().toISOString()
  const up = db.prepare(`
    INSERT INTO gl_accounts (qb_id, acct_num, name, fully_qualified_name, account_type,
      account_sub_type, classification, currency, parent_qb_id, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(qb_id) DO UPDATE SET acct_num = excluded.acct_num, name = excluded.name,
      fully_qualified_name = excluded.fully_qualified_name, account_type = excluded.account_type,
      account_sub_type = excluded.account_sub_type, classification = excluded.classification,
      currency = excluded.currency, parent_qb_id = excluded.parent_qb_id,
      active = excluded.active, updated_at = excluded.updated_at
  `)
  db.transaction(() => {
    for (const a of all) {
      up.run(String(a.Id), a.AcctNum || null, a.Name || null, a.FullyQualifiedName || null,
        a.AccountType || null, a.AccountSubType || null, a.Classification || null,
        a.CurrencyRef?.value || null, a.ParentRef?.value || null, a.Active === false ? 0 : 1, now)
    }
  })()
  return all.length
}

/** Résolveur de compte : id du rapport s'il est connu, sinon nom complet. */
function accountResolver() {
  const rows = db.prepare(`SELECT qb_id, acct_num, name, fully_qualified_name FROM gl_accounts`).all()
  const ids = new Set(rows.map(r => r.qb_id))
  const byName = new Map()
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  for (const r of rows) {
    for (const n of [r.fully_qualified_name, r.name]) {
      if (!n) continue
      byName.set(norm(n), r.qb_id)
      if (r.acct_num) byName.set(norm(`${r.acct_num} ${n}`), r.qb_id)
    }
  }
  return (line) => {
    if (line.account_qb_id && ids.has(line.account_qb_id)) return line.account_qb_id
    return byName.get(norm(line.account_label)) || line.account_qb_id || null
  }
}

// ── Import d'un mois ───────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` }
}

/** Mois 'YYYY-MM' de from à to inclus (acceptent aussi 'YYYY-MM-DD'). */
export function monthsBetween(from, to) {
  const out = []
  let [y, m] = String(from).slice(0, 7).split('-').map(Number)
  const [ty, tm] = String(to).slice(0, 7).split('-').map(Number)
  if (!y || !m || !ty || !tm) throw new Error('Période invalide (attendu AAAA-MM)')
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`)
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

/** Remplace en bloc les écritures d'un mois par celles du JournalReport. */
export async function importGlMonth(ym, { resolve } = {}) {
  const { start, end } = monthBounds(ym)
  const runId = db.prepare(`
    INSERT INTO gl_import_runs (started_at, period_start, period_end, status) VALUES (?, ?, ?, 'running')
  `).run(new Date().toISOString(), start, end).lastInsertRowid
  const finish = (fields) => db.prepare(`
    UPDATE gl_import_runs SET finished_at = ?, entries = ?, lines = ?, status = ?, error = ? WHERE id = ?
  `).run(new Date().toISOString(), fields.entries ?? null, fields.lines ?? null, fields.status, fields.error ?? null, runId)

  try {
    const report = await qbGet(`/reports/JournalReport?start_date=${start}&end_date=${end}`)
    const { entries, total, anomalies } = parseJournalReport(report)
    const issues = [...anomalies]
    const resolveAccount = resolve || accountResolver()

    const seen = new Set()
    for (const e of entries) {
      if (e.txn_date < start || e.txn_date > end) issues.push(`${e.id} datée ${e.txn_date}, hors du mois`)
      if (seen.has(e.id)) issues.push(`${e.id} en double dans le rapport`)
      seen.add(e.id)
      issues.push(...entryIssues(e))
      for (const l of e.lines) {
        l.account_qb_id = resolveAccount(l)
        if (!l.account_qb_id) issues.push(`${e.id} : compte introuvable « ${l.account_label} »`)
      }
    }
    const lineCount = entries.reduce((s, e) => s + e.lines.length, 0)
    if (total) {
      const d = cents(entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.debit, 0), 0))
      const c = cents(entries.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.credit, 0), 0))
      if (Math.abs(d - total.debit) > 0.01 || Math.abs(c - total.credit) > 0.01) {
        issues.push(`total du mois ${d}/${c} ≠ total du rapport ${total.debit}/${total.credit}`)
      }
    }

    const insEntry = db.prepare(`
      INSERT INTO gl_entries (id, txn_type, txn_label, qb_txn_id, txn_date, doc_number, name, memo, source, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qbo', ?)
    `)
    const insLine = db.prepare(`
      INSERT INTO gl_lines (entry_id, line_no, account_qb_id, debit, credit, memo, name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const delLinesOf = db.prepare(`DELETE FROM gl_lines WHERE entry_id = ?`)
    const delEntry = db.prepare(`DELETE FROM gl_entries WHERE id = ?`)
    const now = new Date().toISOString()
    db.transaction(() => {
      db.prepare(`DELETE FROM gl_lines WHERE entry_id IN (SELECT id FROM gl_entries WHERE txn_date BETWEEN ? AND ?)`).run(start, end)
      db.prepare(`DELETE FROM gl_entries WHERE txn_date BETWEEN ? AND ?`).run(start, end)
      for (const e of entries) {
        if (e.txn_date < start || e.txn_date > end) continue
        // Transaction dont la date a changé de mois depuis un import précédent.
        delLinesOf.run(e.id); delEntry.run(e.id)
        insEntry.run(e.id, e.txn_type, e.txn_label, e.qb_txn_id, e.txn_date, e.doc_number, e.name, e.memo, now)
        for (const l of e.lines) insLine.run(e.id, l.line_no, l.account_qb_id, l.debit, l.credit, l.memo, l.name)
      }
    })()

    finish({ entries: entries.length, lines: lineCount, status: issues.length ? 'warning' : 'ok', error: issues.join('\n') || null })
    return { month: ym, entries: entries.length, lines: lineCount, issues }
  } catch (err) {
    finish({ status: 'error', error: err.message })
    throw err
  }
}

// ── Import d'une période ───────────────────────────────────────────────────

let running = null

export function glImportRunning() { return running }

/** Importe mois par mois ; un mois en échec n'arrête pas les suivants. */
export async function importGlRange(from, to, { onMonth } = {}) {
  if (running) throw Object.assign(new Error('Un import du grand livre est déjà en cours'), { status: 409 })
  const months = monthsBetween(from, to)
  running = { from: months[0], to: months.at(-1), done: 0, total: months.length }
  try {
    await refreshGlAccounts()
    const resolve = accountResolver()
    const results = []
    for (const ym of months) {
      let r
      try { r = await importGlMonth(ym, { resolve }) }
      catch (err) { r = { month: ym, error: err.message } }
      results.push(r)
      running.done++
      onMonth?.(r)
    }
    return results
  } finally {
    running = null
  }
}

/** Plus ancienne date comptable de QBO (début de l'historique). */
export async function findEarliestQbDate() {
  const realm = getQbRealmIdSync()
  const candidates = []
  try {
    const ci = await qbGet(`/companyinfo/${realm}`)
    if (ci?.CompanyInfo?.CompanyStartDate) candidates.push(ci.CompanyInfo.CompanyStartDate)
  } catch {}
  for (const e of ['JournalEntry', 'Purchase', 'Deposit', 'Invoice', 'Bill', 'Payment', 'SalesReceipt', 'Transfer']) {
    try {
      const q = `select TxnDate from ${e} order by TxnDate asc startposition 1 maxresults 1`
      const d = (await qbGet(`/query?query=${encodeURIComponent(q)}`))?.QueryResponse?.[e]?.[0]?.TxnDate
      if (d) candidates.push(d)
    } catch {}
  }
  let earliest = candidates.sort()[0] || new Date().toISOString().slice(0, 10)
  // Écritures hors entités interrogeables (ex. « Valeur de départ du stock ») :
  // le rapport lui-même, de 1990 à la date trouvée.
  const r = parseJournalReport(await qbGet(`/reports/JournalReport?start_date=1990-01-01&end_date=${earliest}`))
  for (const e of r.entries) if (e.txn_date < earliest) earliest = e.txn_date
  return earliest
}

/** Compteur : taille du grand livre et équilibre global. */
export function glSummary() {
  const s = db.prepare(`
    SELECT (SELECT COUNT(*) FROM gl_entries) AS entries, COUNT(*) AS lines,
      ROUND(COALESCE(SUM(debit), 0), 2) AS debit, ROUND(COALESCE(SUM(credit), 0), 2) AS credit,
      (SELECT MIN(txn_date) FROM gl_entries) AS first_date, (SELECT MAX(txn_date) FROM gl_entries) AS last_date
    FROM gl_lines
  `).get()
  return { ...s, accounts: db.prepare(`SELECT COUNT(*) AS n FROM gl_accounts`).get().n }
}
