// Grand livre Boréal : bilan et état des résultats (Charles, 2026-10-15, tranche 4/4).
//
// Calculés depuis gl_lines (le grand livre miroir), mis à côté des rapports
// BalanceSheet / ProfitAndLoss de QBO (lecture seule) avec l'écart par ligne.
// Même découpage que QBO : groupe d'un compte = account_type de son ancêtre de
// tête, sous-comptes sous leur parent (parent_qb_id), montant d'un parent =
// lui-même + ses sous-comptes. Signe « naturel » comme les rapports QBO :
// actifs et dépenses débit − crédit, le reste crédit − débit.
//
// Bilan : localTrialBalance (glReconcile.js) — bénéfices non répartis =
// compte + résultats des exercices clos ; bénéfice de l'exercice = résultats du
// début de l'exercice à la date.

import db from '../db/database.js'
import { qbGet, qbEntityUrl } from '../connectors/quickbooks.js'
import { localTrialBalance, loadFiscalStartMonth, qbPageOf } from './glReconcile.js'

const cents = (v) => Math.round(Number(v || 0) * 100) / 100
const NATURAL_DEBIT = new Set(['Asset', 'Expense'])
const sign = (classification) => NATURAL_DEBIT.has(classification) ? 1 : -1

// Nœuds : groupe (types de comptes et/ou sous-groupes) ou total (formule sur
// des groupes). `key` = attribut `group` des sections du rapport QBO.
export const BALANCE_LAYOUT = [
  { key: 'TotalAssets', label: 'Actifs', children: [
    { key: 'OtherCurrentAssets', label: 'Actifs à court terme', children: [
      // QBO range « Fonds non déposés » (Other Current Asset) dans la trésorerie.
      { key: 'BankAccounts', label: 'Trésorerie', types: ['Bank'], subTypes: ['UndepositedFunds'] },
      { key: 'AR', label: 'Comptes clients', types: ['Accounts Receivable'] },
      { types: ['Other Current Asset'] },
    ] },
    { key: 'OtherAssets', label: 'Actifs à long terme', children: [
      { key: 'FixedAssets', label: 'Immobilisations', types: ['Fixed Asset'] },
      { types: ['Other Asset'] },
    ] },
  ] },
  { key: 'Liabilities', label: 'Passifs', children: [
    { key: 'OtherCurrentLiabilities', label: 'Passifs à court terme', children: [
      { key: 'AP', label: 'Comptes fournisseurs', types: ['Accounts Payable'] },
      { key: 'CreditCards', label: 'Cartes de crédit', types: ['Credit Card'] },
      { types: ['Other Current Liability'] },
    ] },
    { key: 'LongTermLiabilities', label: 'Passifs à long terme', types: ['Long Term Liability'] },
  ] },
  { key: 'Equity', label: 'Capital', children: [
    { types: ['Equity'] },
    { key: 'NetIncome', label: "Bénéfice de l'exercice", special: 'netIncome' },
  ] },
  { key: 'TotalLiabilitiesAndEquity', label: 'Passifs et capital', total: [['Liabilities', 1], ['Equity', 1]] },
]

export const INCOME_LAYOUT = [
  { key: 'Income', label: 'Revenus', types: ['Income'] },
  { key: 'COGS', label: 'Coût des ventes', types: ['Cost of Goods Sold'] },
  { key: 'GrossProfit', label: 'Bénéfice brut', total: [['Income', 1], ['COGS', -1]] },
  { key: 'Expenses', label: 'Dépenses', types: ['Expense'] },
  { key: 'NetOperatingIncome', label: "Résultat d'exploitation", total: [['GrossProfit', 1], ['Expenses', -1]] },
  { key: 'OtherIncome', label: 'Autres revenus', types: ['Other Income'] },
  { key: 'OtherExpenses', label: 'Autres dépenses', types: ['Other Expense'] },
  { key: 'NetIncome', label: 'Bénéfice net', total: [['NetOperatingIncome', 1], ['OtherIncome', 1], ['OtherExpenses', -1]] },
]

// ── Rapport QBO ────────────────────────────────────────────────────────────

/**
 * Rapport BalanceSheet / ProfitAndLoss (JSON, une colonne) → { accounts:
 * Map(id → montant sous-comptes compris), groups: Map(group → total) }. Pure.
 */
export function parseQboStatement(report) {
  const cols = report?.Columns?.Column || []
  const idx = Math.max(1, cols.findIndex(c => c.ColType === 'Money'))
  const num = (cd) => cents(Number(cd?.[idx]?.value || 0))
  const accounts = new Map()
  const groups = new Map()
  const walk = (rows) => {
    for (const r of rows || []) {
      if (r.ColData) {
        const id = String(r.ColData[0]?.id ?? '').trim()
        if (id) accounts.set(id, num(r.ColData))
        else if (r.group) groups.set(r.group, num(r.ColData))
      }
      if (r.Rows?.Row) walk(r.Rows.Row)
      if (r.Summary?.ColData) {
        const id = String(r.Header?.ColData?.[0]?.id ?? '').trim()
        if (id) accounts.set(id, num(r.Summary.ColData))
        if (r.group) groups.set(r.group, num(r.Summary.ColData))
      }
    }
  }
  walk(report?.Rows?.Row)
  return { accounts, groups }
}

// ── Construction de l'état ─────────────────────────────────────────────────

/**
 * Lignes à plat d'un état : { id, kind: group|account|total, label, depth,
 * account_qb_id, boreal, qbo, diff }. `amounts` = Map(id → débit − crédit du
 * compte seul) ; `special` = montants hors compte (bénéfice de l'exercice, en
 * signe naturel) ; `qbo` = parseQboStatement ou null. Pure.
 */
export function buildStatement(layout, accounts, amounts, { special = {}, qbo = null } = {}) {
  const byId = new Map(accounts.map(a => [a.qb_id, a]))
  const children = new Map()
  for (const a of accounts) {
    if (a.parent_qb_id && byId.has(a.parent_qb_id)) {
      if (!children.has(a.parent_qb_id)) children.set(a.parent_qb_id, [])
      children.get(a.parent_qb_id).push(a)
    }
  }
  const order = (x, y) => String(x.acct_num || x.name || '').localeCompare(String(y.acct_num || y.name || ''), 'fr', { numeric: true })
  const roots = accounts.filter(a => !a.parent_qb_id || !byId.has(a.parent_qb_id)).sort(order)

  // Montant naturel d'un compte, sous-comptes compris.
  const rollup = new Map()
  const total = (a, seen = new Set()) => {
    if (rollup.has(a.qb_id)) return rollup.get(a.qb_id)
    if (seen.has(a.qb_id)) return 0
    seen.add(a.qb_id)
    const v = sign(a.classification) * (amounts.get(a.qb_id) || 0) +
      (children.get(a.qb_id) || []).reduce((s, c) => s + total(c, seen), 0)
    rollup.set(a.qb_id, cents(v))
    return rollup.get(a.qb_id)
  }
  const qboAcct = (id) => qbo ? (qbo.accounts.get(id) ?? 0) : null
  const used = new Set()

  const accountRows = (a, depth) => {
    used.add(a.qb_id)
    const kids = (children.get(a.qb_id) || []).sort(order).flatMap(c => accountRows(c, depth + 1))
    const boreal = total(a)
    const q = qboAcct(a.qb_id)
    if (!boreal && !q && !kids.length) return []
    return [{ id: `a${a.qb_id}`, kind: 'account', label: [a.acct_num, a.name].filter(Boolean).join(' '),
      depth, account_qb_id: a.qb_id, boreal, qbo: q }, ...kids]
  }

  const rows = []
  const groupTotals = new Map() // key → { boreal, qbo }
  const node = (n, depth) => {
    if (n.total) {
      const boreal = cents(n.total.reduce((s, [k, f]) => s + f * (groupTotals.get(k)?.boreal || 0), 0))
      const calc = qbo ? cents(n.total.reduce((s, [k, f]) => s + f * (groupTotals.get(k)?.qbo || 0), 0)) : null
      const q = qbo ? (qbo.groups.get(n.key) ?? calc) : null
      groupTotals.set(n.key, { boreal, qbo: q })
      rows.push({ id: `t${n.key}`, kind: 'total', label: n.label, depth, boreal, qbo: q })
      return { boreal, qbo: q }
    }
    if (n.special) {
      const boreal = cents(special[n.special] || 0)
      const q = qbo ? (qbo.groups.get(n.key) ?? 0) : null
      if (n.key) groupTotals.set(n.key, { boreal, qbo: q })
      rows.push({ id: `s${n.key}`, kind: 'account', label: n.label, depth, boreal, qbo: q })
      return { boreal, qbo: q }
    }
    const at = rows.length
    const labelled = !!n.label
    const inner = labelled ? depth + 1 : depth
    let boreal = 0
    let q = qbo ? 0 : null
    for (const c of n.children || []) {
      const t = node(c, inner)
      boreal += t.boreal
      if (qbo) q += t.qbo || 0
    }
    const mine = roots.filter(r => !used.has(r.qb_id) &&
      ((n.types || []).includes(r.account_type) || (n.subTypes || []).includes(r.account_sub_type)))
    for (const a of mine) {
      const rs = accountRows(a, inner)
      if (!rs.length) continue
      rows.push(...rs)
      boreal += rs[0].boreal
      if (qbo) q += rs[0].qbo || 0
    }
    boreal = cents(boreal)
    if (qbo) q = qbo.groups.get(n.key) ?? cents(q)
    if (n.key) groupTotals.set(n.key, { boreal, qbo: q })
    if (labelled) rows.splice(at, 0, { id: `g${n.key}`, kind: 'group', label: n.label, depth, boreal, qbo: q })
    return { boreal, qbo: q }
  }
  for (const n of layout) node(n, 0)

  // Comptes que QBO montre et que ce découpage n'a pas placés : visibles, en écart.
  if (qbo) {
    const stray = []
    for (const [id, v] of qbo.accounts) {
      if (used.has(id) || !v) continue
      const a = byId.get(id)
      stray.push({ id: `x${id}`, kind: 'account', label: a ? [a.acct_num, a.name].filter(Boolean).join(' ') : `Compte QBO ${id}`,
        depth: 1, account_qb_id: id, boreal: 0, qbo: v })
    }
    if (stray.length) rows.push({ id: 'gStray', kind: 'group', label: 'Hors découpage', depth: 0, boreal: 0, qbo: cents(stray.reduce((s, r) => s + r.qbo, 0)) }, ...stray)
  }

  for (const r of rows) r.diff = r.qbo == null ? null : cents(r.boreal - r.qbo)
  return rows
}

// ── Calcul depuis le grand livre ───────────────────────────────────────────

const PNL = new Set(['Revenue', 'Expense'])

function glAccounts() {
  return db.prepare(`SELECT qb_id, acct_num, name, account_type, account_sub_type, classification, parent_qb_id FROM gl_accounts`).all()
}

/** Mouvements débit − crédit par compte entre deux dates incluses. */
function periodAmounts(from, to) {
  return new Map(db.prepare(`
    SELECT l.account_qb_id AS id, SUM(l.debit - l.credit) AS v
    FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
    WHERE e.txn_date BETWEEN ? AND ? AND l.account_qb_id IS NOT NULL
    GROUP BY l.account_qb_id
  `).all(from, to).map(r => [r.id, r.v || 0]))
}

async function qboReport(name, from, to) {
  const p = new URLSearchParams({ accounting_method: 'Accrual', start_date: from, end_date: to })
  return parseQboStatement(await qbGet(`/reports/${name}?${p}`))
}

/** Bilan au `to` et état des résultats du `from` au `to`, Boréal ↔ QBO. */
export async function glStatements(from, to) {
  const startMonth = await loadFiscalStartMonth()
  const accounts = glAccounts()
  const cls = new Map(accounts.map(a => [a.qb_id, a.classification]))

  const tb = localTrialBalance(to, startMonth)
  let fyPnl = 0
  for (const [id, v] of tb) if (PNL.has(cls.get(id))) fyPnl += v
  const bsAccounts = accounts.filter(a => !PNL.has(a.classification))
  const pnlAccounts = accounts.filter(a => PNL.has(a.classification))

  let qboBs = null, qboPl = null, qboError = null
  try {
    [qboBs, qboPl] = await Promise.all([qboReport('BalanceSheet', to, to), qboReport('ProfitAndLoss', from, to)])
  } catch (err) { qboError = err.message }

  return {
    from, to, fiscal_start_month: startMonth, qbo_error: qboError,
    balance: buildStatement(BALANCE_LAYOUT, bsAccounts, tb, { special: { netIncome: -fyPnl }, qbo: qboBs }),
    income: buildStatement(INCOME_LAYOUT, pnlAccounts, periodAmounts(from, to), { qbo: qboPl }),
  }
}

/** Lignes du grand livre d'un compte et de ses sous-comptes, entre deux dates. */
export function glAccountLines(accountId, from, to) {
  const all = db.prepare(`SELECT qb_id, parent_qb_id, acct_num, name FROM gl_accounts`).all()
  const ids = new Set([accountId])
  for (let grew = true; grew;) {
    grew = false
    for (const a of all) if (a.parent_qb_id && ids.has(a.parent_qb_id) && !ids.has(a.qb_id)) { ids.add(a.qb_id); grew = true }
  }
  const names = new Map(all.map(a => [a.qb_id, [a.acct_num, a.name].filter(Boolean).join(' ')]))
  const list = [...ids]
  return db.prepare(`
    SELECT l.id, l.account_qb_id, e.txn_date, e.txn_type, e.txn_label, e.qb_txn_id, e.doc_number,
      COALESCE(l.name, e.name) AS name, COALESCE(l.memo, e.memo) AS memo, l.debit, l.credit
    FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
    WHERE l.account_qb_id IN (${list.map(() => '?').join(',')}) AND e.txn_date BETWEEN ? AND ?
    ORDER BY e.txn_date, e.id, l.line_no
  `).all(...list, from, to).map(r => {
    const page = qbPageOf(r.txn_type, r.txn_label)
    return { ...r, account_label: names.get(r.account_qb_id) || null, qb_url: page ? qbEntityUrl(page, r.qb_txn_id) : null }
  })
}
