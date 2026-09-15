// Revenus perçus d'avance — constatation mensuelle.
//
// Une facture encaissée dont la période de service déborde le mois de
// l'encaissement porte du revenu qui n'est pas encore gagné : la portion des
// mois suivants est REPORTÉE (passif 23900) puis constatée mois par mois
// (Dr 23900 / Cr revenus).
//
// Trois règles, non négociables :
//   1. le montant reporté est le HT de la facture, déjà net de rabais
//      (`factures.amount_before_tax_cad` porte le sous-total en devise native,
//      malgré son nom — voir services/quickbooks.js) ;
//   2. la conversion se fait au taux de l'ENCAISSEMENT, jamais au taux du mois
//      de constatation, sinon 23900 garde un résidu de change qui ne se solde
//      jamais (voir postRevenueRecognitionJE) ;
//   3. la période de service vient de l'extraction déjà en place : lignes
//      Stripe (`stripe_invoice_items.period_start/period_end`) et, à défaut,
//      période imprimée retrouvée dans les notes (services/servicePeriod.js).
//
// Ce qui a déjà été constaté est marqué dans `deferred_revenue_recognitions` :
// une ligne présente pour (facture, mois) n'est plus reproposée. Aucun contrôle
// d'idempotance côté QuickBooks — ce registre fait foi.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { qbGet, qbPost, qbEntityUrl } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from './quickbooks.js'
import { getUsdCadRate } from './fx.js'
import { findPeriodRangeInText } from './servicePeriod.js'
import { logSync } from './syncLog.js'

// Comptes du plan comptable (cf. QB_STRIPE_ACCOUNTS).
export const DEFERRAL_ACCTNUM = '23900'        // Revenus perçus d'avance (passif)
const REVENUE_ACCTNUM = { subscription: '41000', order: '40000' }

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const monthOf = iso => String(iso || '').slice(0, 7)
export const isMonth = v => /^\d{4}-\d{2}$/.test(String(v || ''))
const lastDayOf = month => `${month}-${String(daysInMonth(+month.slice(0, 4), +month.slice(5, 7))).padStart(2, '0')}`
const shiftMonth = (month, n) => {
  const total = (+month.slice(0, 4)) * 12 + (+month.slice(5, 7) - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

// ── Étalement (pur, testable) ───────────────────────────────────────────────

// Répartit `amount` sur les mois couverts par [start, end[ au prorata des jours.
// Bornes en ISO (la fin est EXCLUSIVE : Stripe facture du 13 sept au 13 oct,
// le 13 octobre appartient à la période suivante). Le dernier mois absorbe le
// résidu d'arrondi, au cent près.
export function spreadOverMonths(start, end, amount) {
  const from = new Date(start)
  const to = new Date(end)
  if (!(from < to) || !(Number(amount) > 0)) return []
  const totalDays = (to - from) / 86400000
  const months = []
  let cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)
  while (cursor < to.getTime()) {
    const d = new Date(cursor)
    const y = d.getUTCFullYear(); const m = d.getUTCMonth()
    const monthStart = Date.UTC(y, m, 1)
    const nextMonth = Date.UTC(y, m + 1, 1)
    const days = (Math.min(nextMonth, to.getTime()) - Math.max(monthStart, from.getTime())) / 86400000
    if (days > 0) months.push({ month: `${y}-${String(m + 1).padStart(2, '0')}`, days })
    cursor = nextMonth
  }
  let allocated = 0
  return months.map((mo, i) => {
    const value = i === months.length - 1 ? r2(amount - allocated) : r2((amount * mo.days) / totalDays)
    allocated = r2(allocated + value)
    return { month: mo.month, amount: value }
  })
}

// ── Période de service d'une facture encaissée ──────────────────────────────

// Lignes Stripe : la fenêtre couverte est l'enveloppe des lignes qui portent
// une vraie durée. Une ligne de prorata ou un article ponctuel (période de
// quelques secondes, artefact Stripe) ne dit rien de la couverture.
const MIN_WINDOW_MS = 2 * 86400000

export function serviceWindow(facture, items) {
  const spans = (items || [])
    .filter(i => i.period_start && i.period_end && Number(i.amount))
    .map(i => ({ from: Date.parse(i.period_start), to: Date.parse(i.period_end) }))
    .filter(s => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to - s.from >= MIN_WINDOW_MS)
  if (spans.length) {
    return {
      start: new Date(Math.min(...spans.map(s => s.from))).toISOString(),
      end: new Date(Math.max(...spans.map(s => s.to))).toISOString(),
      source: 'stripe',
    }
  }
  // Facture ERP (pas de lignes Stripe) : période imprimée dans les notes.
  const range = findPeriodRangeInText(facture.notes, (facture.document_date || facture.paid_at || '').slice(0, 10))
  if (!range) return null
  const iso = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`
  // Bornes inclusives côté texte → fin exclusive pour l'étalement.
  const end = new Date(Date.parse(iso(range.end)) + 86400000).toISOString()
  return { start: iso(range.start), end, source: 'notes' }
}

// ── Taux de change de l'encaissement ────────────────────────────────────────

// Par ordre de fiabilité : le ratio mémorisé sur la facture au moment où le
// passif a été posé, le taux du paiement saisi, puis le taux du jour de
// l'encaissement (Banque du Canada). Jamais le taux du mois de constatation.
async function encaissementRate(f) {
  if ((f.currency || 'CAD') === 'CAD') return { rate: 1, source: 'CAD' }
  const cad = Number(f.deferred_revenue_amount_cad)
  const native = Number(f.deferred_revenue_amount_native)
  if (cad > 0 && native > 0) return { rate: Math.round((cad / native) * 1e6) / 1e6, source: 'passif différé' }
  const pay = db.prepare(`
    SELECT exchange_rate FROM payments
    WHERE facture_id = ? AND direction = 'in' AND exchange_rate > 0
    ORDER BY received_at DESC LIMIT 1
  `).get(f.id)
  if (pay?.exchange_rate > 0) return { rate: Number(pay.exchange_rate), source: 'taux du paiement' }
  if ((f.currency || '') === 'USD') {
    const day = String(f.paid_at || '').slice(0, 10)
    const rate = await getUsdCadRate(day)
    if (rate > 0) return { rate, source: `taux du ${day}` }
  }
  return { rate: null, source: null }
}

// ── Construction du mois ────────────────────────────────────────────────────

// Factures encaissées susceptibles de déborder sur `month` : encaissées ce
// mois-ci ou dans les 24 mois précédents (au-delà, aucune période de service
// vendue ici ne court encore).
function collectedFactures(month) {
  const from = `${shiftMonth(month, -24)}-01`
  const to = `${lastDayOf(month)}T23:59:59.999Z`
  return db.prepare(`
    SELECT f.id, f.document_number, f.document_date, f.company_id, f.customer_email,
           f.kind, f.currency, f.amount_before_tax_cad, f.paid_at, f.notes, f.invoice_id,
           f.deferred_revenue_amount_cad, f.deferred_revenue_amount_native,
           c.name AS company_name
    FROM factures f
    LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.paid_at IS NOT NULL AND f.paid_at >= ? AND f.paid_at <= ?
      AND COALESCE(f.amount_before_tax_cad, 0) > 0
      AND COALESCE(f.status, '') != 'Void'
    ORDER BY f.paid_at DESC
  `).all(from, to)
}

function itemsByFacture(factureIds) {
  const byId = new Map(factureIds.map(id => [id, []]))
  if (!factureIds.length) return byId
  const CHUNK = 400
  for (let i = 0; i < factureIds.length; i += CHUNK) {
    const slice = factureIds.slice(i, i + CHUNK)
    const rows = db.prepare(`
      SELECT facture_id, amount, period_start, period_end
      FROM stripe_invoice_items WHERE facture_id IN (${slice.map(() => '?').join(',')})
    `).all(...slice)
    for (const r of rows) byId.get(r.facture_id)?.push(r)
  }
  return byId
}

function recognitionsFor(month) {
  return db.prepare(`
    SELECT * FROM deferred_revenue_recognitions WHERE month = ? AND deleted_at IS NULL
  `).all(month)
}

// L'état complet du mois : une ligne par facture dont le revenu reporté touche
// encore `month`, plus les totaux du pied de tableau.
export async function buildMonth(month) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const factures = collectedFactures(month)
  const items = itemsByFacture(factures.map(f => f.id))
  const doneByFacture = new Map(recognitionsFor(month).map(r => [r.facture_id, r]))

  const rows = []
  const warnings = []
  for (const f of factures) {
    const window = serviceWindow(f, items.get(f.id))
    if (!window) continue
    const collectedMonth = monthOf(f.paid_at)
    const htNative = r2(f.amount_before_tax_cad)
    const schedule = spreadOverMonths(window.start, window.end, htNative)
    // Portion qui déborde le mois d'encaissement — c'est elle, et elle seule,
    // qui est reportée. Une facture entièrement consommée dans son mois n'a
    // rien à reporter et ne s'affiche pas.
    const deferred = schedule.filter(s => s.month > collectedMonth)
    if (!deferred.length) continue
    const lastMonth = deferred[deferred.length - 1].month
    if (month < collectedMonth || month > lastMonth) continue

    const { rate, source: fxSource } = await encaissementRate(f)
    const conv = n => (rate ? r2(n * rate) : null)
    const deferredNative = r2(deferred.reduce((s, d) => s + d.amount, 0))
    const beforeNative = r2(deferred.filter(d => d.month < month).reduce((s, d) => s + d.amount, 0))
    const thisMonthNative = r2(deferred.find(d => d.month === month)?.amount || 0)
    const remainingNative = r2(deferredNative - beforeNative - thisMonthNative)
    const done = doneByFacture.get(f.id)
    if (!rate) warnings.push(`Taux USD→CAD introuvable pour #${f.document_number || f.id} — ligne non constatable`)

    rows.push({
      id: f.id,
      facture_id: f.id,
      document_number: f.document_number || f.id,
      company_id: f.company_id,
      company_name: f.company_name || f.customer_email || '—',
      source: f.invoice_id ? 'Stripe' : 'Facture ERP',
      kind: f.kind,
      currency: f.currency || 'CAD',
      collected_at: f.paid_at,
      period_start: window.start,
      period_end: window.end,
      period_source: window.source,
      total_ht_native: htNative,
      total_ht_cad: conv(htNative),
      exchange_rate: rate,
      fx_source: fxSource,
      deferred_cad: conv(deferredNative),
      recognized_before_cad: conv(beforeNative),
      to_recognize_cad: conv(thisMonthNative),
      to_recognize_native: thisMonthNative,
      remaining_cad: conv(remainingNative),
      deferral_acctnum: DEFERRAL_ACCTNUM,
      revenue_acctnum: REVENUE_ACCTNUM[f.kind] || REVENUE_ACCTNUM.subscription,
      recognized: !!done,
      recognized_at: done?.pushed_at || done?.created_at || null,
      qb_je_id: done?.qb_je_id || null,
      qb_je_url: done?.qb_je_id ? qbEntityUrl('journal', done.qb_je_id) : null,
    })
  }

  // Ce qu'on vient faire ici, c'est constater : les lignes qui portent un
  // montant ce mois-ci passent devant, le reste suit par ordre de report.
  rows.sort((a, b) => (b.to_recognize_cad || 0) - (a.to_recognize_cad || 0)
    || (b.remaining_cad || 0) - (a.remaining_cad || 0)
    || String(a.company_name).localeCompare(String(b.company_name)))

  const sum = (list, key) => r2(list.reduce((s, r) => s + (r[key] || 0), 0))
  const pending = rows.filter(r => !r.recognized && r.to_recognize_cad > 0 && r.exchange_rate)
  return {
    month,
    rows,
    deferral_acctnum: DEFERRAL_ACCTNUM,
    totals: {
      to_recognize: sum(rows.filter(r => !r.recognized), 'to_recognize_cad'),
      already_recognized: sum(rows.filter(r => r.recognized), 'to_recognize_cad'),
      remaining: sum(rows, 'remaining_cad'),
      deferred: sum(rows, 'deferred_cad'),
      pending_count: pending.length,
    },
    warnings: [...new Set(warnings)],
    draft: getDraft(month),
  }
}

// ── Rapprochement avec le solde QuickBooks ──────────────────────────────────

// Solde du compte de report dans QB à la fin du mois (bilan à cette date). Le
// compte porte AUSSI les dépôts de commandes non expédiées : l'écart affiché
// est un signal à expliquer, pas une erreur en soi.
export async function qbReconciliation(month) {
  if (!isMonth(month)) throw new Error('Mois invalide (YYYY-MM attendu)')
  const accountId = await resolveAccountByAcctNum(DEFERRAL_ACCTNUM)
  if (!accountId) throw new Error(`Compte QB #${DEFERRAL_ACCTNUM} introuvable`)
  const params = new URLSearchParams({ accounting_method: 'Accrual', end_date: lastDayOf(month) })
  const data = await qbGet(`/reports/BalanceSheet?${params}`)

  let found = null
  const walk = rows => {
    for (const row of rows?.Row || []) {
      if (row.ColData && String(row.ColData[0]?.id || '') === String(accountId)) {
        found = { name: row.ColData[0]?.value || '', balance: r2(row.ColData[1]?.value) }
      }
      if (row.Rows) walk(row.Rows)
    }
  }
  walk((data?.Report || data)?.Rows)

  const built = await buildMonth(month)
  const erp = built.totals.remaining
  return {
    month,
    acctnum: DEFERRAL_ACCTNUM,
    account_name: found?.name || null,
    qb_balance: found ? found.balance : null,
    erp_balance: erp,
    ecart: found ? r2(found.balance - erp) : null,
  }
}

// ── Brouillon d'écriture ────────────────────────────────────────────────────

export function getDraft(month) {
  const row = db.prepare(`
    SELECT * FROM deferred_revenue_drafts WHERE month = ? AND deleted_at IS NULL
  `).get(month)
  if (!row) return null
  let lines = []
  try { lines = JSON.parse(row.lines || '[]') } catch { lines = [] }
  return {
    ...row,
    lines,
    total: r2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)),
    qb_je_url: row.qb_je_id ? qbEntityUrl('journal', row.qb_je_id) : null,
  }
}

// Prépare (ou re-prépare) le brouillon du mois à partir des lignes non encore
// constatées. Le brouillon reste modifiable : c'est lui, et pas le calcul, qui
// part dans QuickBooks.
export async function proposeDraft(month, { aggregated = false, userId = null } = {}) {
  const built = await buildMonth(month)
  const existing = getDraft(month)
  if (existing?.pushed_at) throw new Error('Le mois est déjà comptabilisé — supprimer le brouillon pour en repartir')

  const pending = built.rows.filter(r => !r.recognized && r.to_recognize_cad > 0 && r.exchange_rate)
  if (!pending.length) throw new Error('Rien à constater pour ce mois')

  let lines
  if (aggregated) {
    const byAccount = new Map()
    for (const r of pending) {
      const prev = byAccount.get(r.revenue_acctnum) || { amount: 0, facture_ids: [] }
      prev.amount = r2(prev.amount + r.to_recognize_cad)
      prev.facture_ids.push(r.facture_id)
      byAccount.set(r.revenue_acctnum, prev)
    }
    lines = [...byAccount.entries()].map(([acctnum, v]) => ({
      label: `Constatation des revenus perçus d'avance — ${month}`,
      revenue_acctnum: acctnum,
      amount: v.amount,
      facture_ids: v.facture_ids,
    }))
  } else {
    lines = pending.map(r => ({
      label: `${r.company_name} — #${r.document_number}`,
      revenue_acctnum: r.revenue_acctnum,
      amount: r.to_recognize_cad,
      facture_ids: [r.facture_id],
    }))
  }

  const memo = `Constatation des revenus perçus d'avance — ${month} (ERP)`
  const now = new Date().toISOString()
  if (existing) {
    db.prepare(`
      UPDATE deferred_revenue_drafts
      SET aggregated = ?, txn_date = ?, memo = ?, lines = ?, deferral_acctnum = ?, updated_at = ?
      WHERE id = ?
    `).run(aggregated ? 1 : 0, lastDayOf(month), memo, JSON.stringify(lines), DEFERRAL_ACCTNUM, now, existing.id)
  } else {
    db.prepare(`
      INSERT INTO deferred_revenue_drafts (id, month, aggregated, txn_date, memo, lines, deferral_acctnum, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(newRecordId(), month, aggregated ? 1 : 0, lastDayOf(month), memo, JSON.stringify(lines), DEFERRAL_ACCTNUM, userId)
  }
  return getDraft(month)
}

const DRAFT_FIELDS = ['txn_date', 'memo', 'lines', 'aggregated']

export function updateDraft(month, patch = {}) {
  const existing = getDraft(month)
  if (!existing) throw new Error('Aucun brouillon pour ce mois')
  if (existing.pushed_at) throw new Error('Écriture déjà comptabilisée — plus modifiable')
  const sets = []
  const values = []
  for (const key of DRAFT_FIELDS) {
    if (!(key in patch)) continue
    sets.push(`${key} = ?`)
    if (key === 'lines') values.push(JSON.stringify(Array.isArray(patch.lines) ? patch.lines : []))
    else if (key === 'aggregated') values.push(patch.aggregated ? 1 : 0)
    else values.push(patch[key] ?? null)
  }
  if (sets.length) {
    db.prepare(`UPDATE deferred_revenue_drafts SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, existing.id)
  }
  return getDraft(month)
}

export function deleteDraft(month) {
  const existing = getDraft(month)
  if (!existing) return { ok: true }
  if (existing.pushed_at) throw new Error('Écriture déjà comptabilisée — le brouillon reste comme trace')
  db.prepare(`UPDATE deferred_revenue_drafts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(existing.id)
  return { ok: true }
}

// ── Comptabilisation (action humaine explicite) ─────────────────────────────

// Publie le brouillon tel qu'il est affiché : Dr report / Cr revenus. Le claim
// (registre des constatations) est posé AVANT le POST et annulé si le POST
// échoue — même pattern que publishFpaMonth.
export async function publishMonth(month, { userId = null } = {}) {
  const draft = getDraft(month)
  if (!draft) throw new Error('Aucun brouillon à comptabiliser — préparer l\'écriture d\'abord')
  if (draft.pushed_at) throw new Error(`Mois déjà comptabilisé (JE ${draft.qb_je_id || '?'})`)
  const lines = draft.lines.filter(l => Number(l.amount) > 0)
  if (!lines.length) throw new Error('Le brouillon ne porte aucun montant')

  const built = await buildMonth(month)
  const byFacture = new Map(built.rows.map(r => [r.facture_id, r]))
  const claimed = []
  const now = new Date().toISOString()
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO deferred_revenue_recognitions
        (id, facture_id, month, amount_cad, amount_native, currency, exchange_rate, fx_source,
         deferral_acctnum, revenue_acctnum, source, pushed_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,'auto',?,?)
    `)
    for (const line of lines) {
      for (const factureId of line.facture_ids || []) {
        const r = byFacture.get(factureId)
        if (!r) continue
        if (r.recognized) throw new Error(`#${r.document_number} : déjà constatée pour ${month}`)
        const id = newRecordId()
        insert.run(id, factureId, month, r.to_recognize_cad, r.to_recognize_native, r.currency,
          r.exchange_rate, r.fx_source, draft.deferral_acctnum || DEFERRAL_ACCTNUM,
          line.revenue_acctnum || r.revenue_acctnum, now, userId)
        claimed.push(id)
      }
    }
  })()

  try {
    const deferralId = await resolveAccountByAcctNum(draft.deferral_acctnum || DEFERRAL_ACCTNUM)
    if (!deferralId) throw new Error(`Compte QB #${draft.deferral_acctnum || DEFERRAL_ACCTNUM} introuvable`)
    const total = r2(lines.reduce((s, l) => s + Number(l.amount), 0))
    const qbLines = []
    for (const line of lines) {
      const revenueId = await resolveAccountByAcctNum(line.revenue_acctnum)
      if (!revenueId) throw new Error(`Compte QB #${line.revenue_acctnum} introuvable (${line.label})`)
      qbLines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: r2(line.amount),
        Description: line.label,
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: revenueId } },
      })
    }
    qbLines.unshift({
      DetailType: 'JournalEntryLineDetail',
      Amount: total,
      Description: `Constatation ${month}`,
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: deferralId } },
    })
    const result = await qbPost('/journalentry', {
      TxnDate: draft.txn_date || lastDayOf(month),
      PrivateNote: draft.memo,
      Line: qbLines,
    })
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry")

    db.prepare(`
      UPDATE deferred_revenue_drafts SET qb_je_id = ?, pushed_at = ?, updated_at = ? WHERE id = ?
    `).run(String(jeId), now, now, draft.id)
    if (claimed.length) {
      db.prepare(`
        UPDATE deferred_revenue_recognitions SET qb_je_id = ?, updated_at = ?
        WHERE id IN (${claimed.map(() => '?').join(',')})
      `).run(String(jeId), now, ...claimed)
    }
    logSync('deferred_revenue', 'manual', { status: 'success', modified: claimed.length })
    return { month, qb_je_id: String(jeId), lines: lines.length, total, recognitions: claimed.length }
  } catch (e) {
    if (claimed.length) {
      db.prepare(`DELETE FROM deferred_revenue_recognitions WHERE qb_je_id IS NULL AND id IN (${claimed.map(() => '?').join(',')})`)
        .run(...claimed)
    }
    logSync('deferred_revenue', 'manual', { status: 'error', error: e.message })
    throw e
  }
}
