// Contrôle des rattachements « ligne de dépense ↔ achat LIA ».
//
// Une ligne de dépense désigne son achat par le code LIA en tête de sa description
// (« LIA-2018⇥HEAT SINK KIT… ») : c'est ce code, publié dans QuickBooks, qu'Airtable lit
// pour relier la ligne à l'achat — et dont il tire le prix unitaire de l'achat. Un code
// faux fausse donc le prix d'un vieil achat et laisse la commande du jour sans facture.
//
// Deux anomalies sont cherchées :
//   - DÉJÀ REÇU : l'achat n'était plus dans la section « À recevoir » à la date de la
//     dépense (reçu avant, ou « 1970-01-01 » = reçu à une date inconnue). Seuls les codes
//     « À recevoir » peuvent porter une facture ;
//   - RELIÉ DEUX FOIS : le même achat est désigné par plusieurs lignes de dépense. Parfois
//     légitime (dépôt + solde), souvent un doublon — à regarder, pas à corriger d'office.
//
// Sources des lignes : les dépenses et factures importées de QuickBooks (achats_fournisseurs,
// ce qui est réellement comptabilisé), plus les reçus de l'ERP pas encore publiés. Un reçu
// publié n'est pas compté deux fois : sa transaction QuickBooks le représente déjà.
import db from '../db/database.js'
import { orderGapDays } from './purchaseLiaMatch.js'

const LEADING_LIA = /^\s*(lia-\d+)/i
const liaOf = desc => (LEADING_LIA.exec(String(desc || '')) || [])[1]?.toUpperCase() || null
const day = d => (String(d || '').slice(0, 10) || null)

// L'achat était-il encore « À recevoir » à la date de la dépense ? null si on ne peut
// pas juger (dépense sans date). « 1970-01-01 » = reçu à une date inconnue : déjà reçu.
export function pendingAtExpense(receivedDate, expenseDate) {
  const r = day(receivedDate)
  if (!r) return true
  if (r <= '1970-01-02') return false
  const e = day(expenseDate)
  if (!e) return null
  return r >= e
}

function purchasesIndex() {
  const rows = db.prepare(`
    SELECT id, at_id, date_de_commande, cf_date_de_reception_complete, depense_line_item, supplier_vendor_name
    FROM purchases WHERE at_id IS NOT NULL AND at_id <> ''
  `).all()
  const byRef = new Map(), byId = new Map()
  for (const r of rows) {
    let dli = []
    try { dli = JSON.parse(r.depense_line_item || '[]') } catch {}
    const p = { id: r.id, lia_ref: r.at_id.toUpperCase(), order_date: day(r.date_de_commande), received_date: day(r.cf_date_de_reception_complete), supplier: r.supplier_vendor_name, airtable_links: Array.isArray(dli) ? dli.length : 0 }
    byRef.set(p.lia_ref, p)
    byId.set(r.id, p)
  }
  return { byRef, byId }
}

/** Toutes les lignes de dépense qui désignent un achat LIA. */
export function collectExpenseLines() {
  const out = []
  const qbTxns = new Set()
  const qbRows = db.prepare(`
    SELECT id, type, date_achat, vendor, reference, quickbooks_id, lines, currency, exchange_rate
    FROM achats_fournisseurs WHERE lines LIKE '%LIA-%'
  `).all()
  for (const r of qbRows) {
    if (r.quickbooks_id) qbTxns.add(String(r.quickbooks_id))
    let lines = []
    try { lines = JSON.parse(r.lines || '[]') } catch { continue }
    lines.forEach((l, i) => {
      const ref = liaOf(l?.description)
      if (!ref) return
      out.push({
        source: 'qb', txn_key: `qb:${r.type}:${r.quickbooks_id || r.id}`, record_id: r.id, quickbooks_id: r.quickbooks_id,
        date: day(r.date_achat), printed_order_date: null, vendor: r.vendor, reference: r.reference,
        line: i + 1, lia_ref: ref, purchase_id: null, amount: l?.amount ?? null, description: l?.description || '',
        currency: r.currency || 'CAD', rate: Number(r.exchange_rate) || null,
      })
    })
  }
  const receipts = db.prepare(`
    SELECT id, receipt_number, receipt_date, order_date, company, quickbooks_id, items, currency, fx_converted_to
    FROM sale_receipts
    WHERE deleted_at IS NULL AND COALESCE(total, 0) <> 0
      AND (items LIKE '%purchase_id%' OR items LIKE '%LIA-%')
  `).all()
  for (const r of receipts) {
    if (r.quickbooks_id && qbTxns.has(String(r.quickbooks_id))) continue
    let items = []
    try { items = JSON.parse(r.items || '[]') } catch { continue }
    items.forEach((it, i) => {
      const ref = it?.lia_ref ? String(it.lia_ref).toUpperCase() : liaOf(it?.description)
      if (!ref && !it?.purchase_id) return
      out.push({
        source: 'erp', txn_key: `erp:${r.id}`, record_id: r.id, quickbooks_id: r.quickbooks_id,
        date: day(r.receipt_date), printed_order_date: day(r.order_date), vendor: r.company, reference: r.receipt_number,
        line: i + 1, lia_ref: ref, purchase_id: it?.purchase_id || null, amount: it?.total ?? null, description: it?.description || '',
        // Montants convertis : ils sont exprimés dans `fx_converted_to`.
        currency: r.fx_converted_to || r.currency || 'CAD', rate: null,
      })
    })
  }
  return out
}

function resolve(line, idx) {
  return (line.purchase_id && idx.byId.get(line.purchase_id)) || (line.lia_ref && idx.byRef.get(line.lia_ref)) || null
}

/**
 * Pour l'affichage d'une dépense : date de commande de chaque achat désigné, écart,
 * « À recevoir » ou non à la date de la dépense, et autres lignes de dépense qui désignent le même achat.
 *
 * @param {{ refs?: string[], ids?: string[], expenseDate?: string, excludeTxnKey?: string }} opts
 * @returns {Object<string, {purchase_id, lia_ref, order_date, received_date, gap_days, pending_at_expense, other_links: Array}>}
 *          indexé par code LIA ET par id d'achat
 */
export function describeLinkedPurchases({ refs = [], ids = [], expenseDate = null, excludeTxnKey = null } = {}) {
  const idx = purchasesIndex()
  const wanted = [
    ...refs.map(r => idx.byRef.get(String(r).toUpperCase())),
    ...ids.map(id => idx.byId.get(id)),
  ].filter(Boolean)
  if (!wanted.length) return {}
  const ids2 = new Set(wanted.map(p => p.id))
  const others = new Map()
  for (const l of collectExpenseLines()) {
    if (excludeTxnKey && l.txn_key === excludeTxnKey) continue
    const p = resolve(l, idx)
    if (!p || !ids2.has(p.id)) continue
    if (!others.has(p.id)) others.set(p.id, [])
    others.get(p.id).push({ source: l.source, record_id: l.record_id, quickbooks_id: l.quickbooks_id, reference: l.reference, date: l.date, vendor: l.vendor })
  }
  const out = {}
  for (const p of wanted) {
    const info = {
      purchase_id: p.id, lia_ref: p.lia_ref, order_date: p.order_date, received_date: p.received_date,
      gap_days: orderGapDays(p.order_date, expenseDate),
      pending_at_expense: pendingAtExpense(p.received_date, expenseDate),
      other_links: others.get(p.id) || [],
    }
    out[p.lia_ref] = info
    out[p.id] = info
  }
  return out
}

/**
 * Passe complète : lignes reliées à un achat déjà reçu, et achats reliés plusieurs fois.
 * Lecture seule — rien n'est corrigé ici.
 */
export function auditPurchaseLinks() {
  const idx = purchasesIndex()
  const lines = collectExpenseLines()
  const alreadyReceived = []
  const unknown = []
  const byPurchase = new Map()
  for (const l of lines) {
    const p = resolve(l, idx)
    if (!p) { unknown.push(l); continue }
    if (pendingAtExpense(p.received_date, l.date) === false) {
      alreadyReceived.push({ ...l, lia_ref: p.lia_ref, order_date: p.order_date, received_date: p.received_date })
    }
    if (!byPurchase.has(p.id)) byPurchase.set(p.id, { purchase: p, lines: [] })
    byPurchase.get(p.id).lines.push(l)
  }
  const doubles = []
  for (const { purchase, lines: ls } of byPurchase.values()) {
    const txns = new Set(ls.map(l => `${l.txn_key}#${l.line}`))
    if (txns.size >= 2 || purchase.airtable_links >= 2) doubles.push({ purchase, lines: ls })
  }
  // Achats reliés plusieurs fois dans Airtable par des lignes que l'ERP ne voit pas
  // (dépenses antérieures à l'import QuickBooks).
  for (const p of idx.byId.values()) {
    if (p.airtable_links >= 2 && !byPurchase.has(p.id)) doubles.push({ purchase: p, lines: [] })
  }
  alreadyReceived.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  doubles.sort((a, b) => String(b.purchase.lia_ref).localeCompare(String(a.purchase.lia_ref), 'fr', { numeric: true }))
  return { scanned: lines.length, alreadyReceived, doubles, unknown }
}

// Montant CAD d'une ligne : QuickBooks donne le taux de la transaction ; un reçu ERP
// en devise non convertie n'en a pas → null (le prix payé reste alors inconnu).
function amountCad(l) {
  const a = Number(l.amount)
  if (!Number.isFinite(a)) return null
  if (String(l.currency || 'CAD').toUpperCase() === 'CAD') return a
  return l.rate ? a * l.rate : null
}

const AIRTABLE_EXPENSE_LINES_TABLE = 'tblVBiMusdVyU9hSW'

/**
 * Lignes de dépense (factures fournisseurs) reliées à chaque achat, et prix unitaire
 * payé qui en découle : « Override prix unitaire payé » s'il est rempli (comme la
 * formule Airtable), sinon Σ montants CAD avant taxes / quantité commandée.
 * Les liens Airtable (« Dépense Line item ») que l'ERP ne voit pas sont rendus en repli.
 *
 * @param {{ ids?: string[] }} opts — sans ids : tous les achats
 * @returns {Object<string, {lines: Array, airtable_links: Array<string>, paid_total_cad: number|null, unit_price_paid_cad: number|null}>}
 */
export function expenseLinesByPurchase({ ids = null } = {}) {
  const idx = purchasesIndex()
  const wanted = ids ? new Set(ids) : null
  const byId = new Map()
  for (const l of collectExpenseLines()) {
    const p = resolve(l, idx)
    if (!p || (wanted && !wanted.has(p.id))) continue
    if (!byId.has(p.id)) byId.set(p.id, [])
    byId.get(p.id).push({
      source: l.source, record_id: l.record_id, reference: l.reference, date: l.date, vendor: l.vendor,
      line: l.line, description: l.description, amount: l.amount, currency: l.currency, amount_cad: amountCad(l),
    })
  }
  const base = db.prepare(`SELECT base_id FROM airtable_module_config WHERE module = 'achats'`).get()?.base_id || null
  const rows = db.prepare(`
    SELECT id, quantite_commande, override_prix_unitaire_paye_cad, depense_line_item FROM purchases
  `).all()
  const out = {}
  for (const r of rows) {
    if (wanted && !wanted.has(r.id)) continue
    const lines = byId.get(r.id) || []
    let at = []
    try { at = JSON.parse(r.depense_line_item || '[]') } catch {}
    const airtable = base && Array.isArray(at) ? at.map(rec => `https://airtable.com/${base}/${AIRTABLE_EXPENSE_LINES_TABLE}/${rec}`) : []
    if (!lines.length && !airtable.length) continue
    const cad = lines.map(l => l.amount_cad)
    const total = lines.length && cad.every(v => v != null) ? Math.round(cad.reduce((s, v) => s + v, 0) * 100) / 100 : null
    const qty = Number(r.quantite_commande)
    const override = Number(r.override_prix_unitaire_paye_cad)
    const unit = r.override_prix_unitaire_paye_cad != null && r.override_prix_unitaire_paye_cad !== '' && Number.isFinite(override)
      ? override
      : (total != null && qty > 0 ? Math.round((total / qty) * 10000) / 10000 : null)
    out[r.id] = { lines, airtable_links: lines.length ? [] : airtable, paid_total_cad: total, unit_price_paid_cad: unit }
  }
  return out
}
