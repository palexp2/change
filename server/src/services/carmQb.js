// Écritures QuickBooks du compte ASFC.
//
// MODÈLE (aligné le 2026-10-10 sur ce que la comptable fait à la main —
// décision de Charles ; procédure CTB du fichier Drive « ASFC_Suivi_Trx ») :
//   • charges d'un lot (B3, C1, intérêts, pénalités — nettes des corrections)
//     → UNE FACTURE FOURNISSEUR « ASFC » : droits en 65000, intérêts en 79200,
//     pénalités en 70100, TPS à l'importation portée par la taxe de la facture
//     (CTI 100 %). Ex. facture 18031 du 2026-08-01, mémo « Pour ctb les
//     transactions non réglées à l'ASFC (du … au …) » ;
//   • notre versement → PAIEMENT DE FACTURE (carte ou banque) qui règle les
//     factures ASFC ouvertes ; le surplus → DÉPENSE « Trop versé à l'ASFC »
//     imputée aux Comptes fournisseurs (21000, fournisseur ASFC débiteur).
//     Ex. 500 $ du 2026-08-03 = paiement 18033 (267,12) + dépense 18032 (232,88) ;
//   • lignes FedEx → rien : FedEx paie l'ASFC et nous refacture (sa facture
//     porte la TPS). Axxess ne paie pas : ses lignes sont à nous.
// Remplace le modèle « écriture de journal » du 2026-09-01 : les JE 17945/17946
// ont été supprimées dans QB et refaites à la main en facture.
//
// SONDÉ SUR LE VRAI FICHIER QB (2026-08-22, transactions créées puis supprimées) :
//   1. une ligne de dépense imputée aux Comptes fournisseurs avec EntityRef
//      fournisseur est ACCEPTÉE (c'est l'avance au compte ASFC) ;
//   2. une JE imputée à un compte Comptes fournisseurs exige un Entity
//      Vendor sur cette ligne (JournalEntryLineDetail.Entity =
//      { Type: 'Vendor', EntityRef: { value } }), sinon QB refuse.
import db from '../db/database.js'
import { mainQbAccount } from '../utils/qbBankAccount.js'
import { qbPost, qbGet, qbRequest } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum, resolveTaxCodeIdsByName, findOrCreateVendor, loadAccountsCache } from './quickbooks.js'
import { getCarmConfig } from './carmAccount.js'
import { KIND_LABELS } from './carmRules.js'
import { logSync } from './syncLog.js'
import { round2Safe as round2 } from '../utils/money.js'

const GST_RATE = 0.05

// Natures dont la ventilation droits / TPS est connue : les seules qui peuvent
// partir dans QuickBooks. « evaluation » et « correction » veulent dire « le
// relevé ne dit pas si c'est des droits ou de la TPS » — à ventiler d'abord.
const SPLIT_KNOWN = new Set(['tps', 'droits', 'surtaxe', 'interet', 'penalite'])

// ── Regroupement ─────────────────────────────────────────────────────────────
// Un B3 arrive en plusieurs lignes (droits + TPS, même numéro) → une seule
// facture. Un versement de 500 $ arrive en deux lignes (297,32 + 202,68) → une
// seule dépense, du montant exact de la ligne bancaire.
export function buildPostingGroups(lines, { tolerance = null } = {}) {
  const groups = new Map()
  for (const l of lines) {
    if (l.posting_state !== 'a_comptabiliser') continue
    const isPayment = l.kind === 'paiement'
    if (isPayment && l.payer === 'courtier') continue
    const sign = Number(l.amount) < 0 ? 'credit' : 'debit'
    const type = isPayment ? 'paiement' : (sign === 'credit' ? 'credit' : 'charge')
    const key = `${type}|${l.transaction_date}|${(l.transaction_number || l.id).trim()}`
    if (!groups.has(key)) {
      groups.set(key, {
        id: key, type, date: l.transaction_date, number: l.transaction_number || null,
        lines: [], duty: 0, gst: 0, interest: 0, penalty: 0, total: 0, blockers: [], warnings: [],
      })
    }
    const g = groups.get(key)
    g.lines.push(l)
    const amt = Math.abs(Number(l.amount) || 0)
    g.total = round2(g.total + amt)
    if (type === 'paiement') continue
    const split = l.duty_amount != null || l.gst_amount != null
    if (!SPLIT_KNOWN.has(l.kind) && !split) {
      // « Évaluation » / « correction » = le relevé ne dit pas si c'est des
      // droits ou de la TPS. Dès que la ventilation est saisie (ou déduite),
      // la ligne redevient comptabilisable.
      g.blockers.push(`ligne de ${amt.toFixed(2)} $ à ventiler (droits ou TPS ?)`)
      continue
    }
    if (l.kind === 'interet') g.interest = round2(g.interest + amt)
    else if (l.kind === 'penalite') g.penalty = round2(g.penalty + amt)
    else {
      g.duty = round2(g.duty + Math.abs(Number(l.duty_amount) || 0))
      g.gst = round2(g.gst + Math.abs(Number(l.gst_amount) || 0))
    }
  }
  // Contrôle d'équilibre : ce qu'on s'apprête à écrire doit valoir le relevé.
  const tol = tolerance != null ? Number(tolerance) : (Number(getCarmConfig().delta_tolerance) || 0.02)
  for (const g of groups.values()) {
    if (g.type === 'paiement') continue
    const built = round2(g.duty + g.gst + g.interest + g.penalty)
    if (!g.blockers.length && Math.abs(built - g.total) > tol) {
      g.blockers.push(`écriture de ${built.toFixed(2)} $ pour ${g.total.toFixed(2)} $ au relevé`)
    }
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
}

// ── Payloads ─────────────────────────────────────────────────────────────────

const expenseLine = (amount, accountId, taxCodeId, description) => ({
  Amount: round2(amount),
  DetailType: 'AccountBasedExpenseLineDetail',
  Description: description,
  AccountBasedExpenseLineDetail: {
    AccountRef: { value: accountId },
    TaxCodeRef: { value: taxCodeId },
    BillableStatus: 'NotBillable',
  },
})

// Charge 100 % TPS : QB refuse une taxe dont aucune ligne ne porte le code, et
// une ligne au montant de la TPS la compterait deux fois. D'où le couple
// +0,01 / −0,01 (somme nulle) déjà utilisé dans l'historique QB de l'entreprise.
export function buildGstOnlyLines(accountId, tpsCodeId, noTaxCodeId) {
  return [
    expenseLine(0.01, accountId, tpsCodeId, 'TPS à l\'importation'),
    expenseLine(-0.01, accountId, noTaxCodeId, 'Contrepartie'),
  ]
}

export function buildChargeLines(g, ids) {
  const lines = []
  if (g.duty > 0) lines.push(expenseLine(g.duty, ids.duty, g.gst > 0 ? ids.tps : ids.noTax, 'Droits de douane'))
  if (g.interest > 0) lines.push(expenseLine(g.interest, ids.interest, ids.noTax, 'Intérêts'))
  if (g.penalty > 0) lines.push(expenseLine(g.penalty, ids.penalty, ids.noTax, 'Pénalité'))
  if (g.gst > 0 && g.duty <= 0) lines.push(...buildGstOnlyLines(ids.duty, ids.tps, ids.noTax))
  return lines
}

function mergedMemo(groups) {
  if (groups.length === 1) return memo(groups[0])
  const parts = []
  if (groups.some(g => g.duty > 0)) parts.push('droits de douane')
  if (groups.some(g => g.gst > 0)) parts.push('TPS à l\'importation')
  if (groups.some(g => g.interest > 0)) parts.push('intérêts')
  if (groups.some(g => g.penalty > 0)) parts.push('pénalité')
  const nature = parts.join(' et ') || 'douanes'
  return `${nature.charAt(0).toUpperCase()}${nature.slice(1)} — ${groups.length} déclarations ASFC`
}

// Charge/note de crédit → écriture de journal (jamais une facture fournisseur,
// voir l'en-tête du fichier). Débit des comptes de coûts + TPS en CTI (compte
// d'attente), crédit du solde fournisseur ASFC (21000, avec Entity) ; sens
// inverse pour une note de crédit. Marche pour un groupe seul ou fusionné.
const journalLine = (amount, accountId, postingType, description, entity) => ({
  Amount: round2(amount),
  DetailType: 'JournalEntryLineDetail',
  Description: description,
  JournalEntryLineDetail: {
    PostingType: postingType,
    AccountRef: { value: accountId },
    ...(entity ? { Entity: entity } : {}),
  },
})

export function buildChargeJournalLines(groups, ids) {
  const side = groups[0].type === 'credit' ? 'Credit' : 'Debit'
  const lines = []
  for (const g of groups) {
    const suffix = g.number ? ` — ${g.number}` : ''
    if (g.duty > 0) lines.push(journalLine(g.duty, ids.duty, side, `Droits de douane${suffix}`))
    if (g.interest > 0) lines.push(journalLine(g.interest, ids.interest, side, `Intérêts${suffix}`))
    if (g.penalty > 0) lines.push(journalLine(g.penalty, ids.penalty, side, `Pénalité${suffix}`))
    if (g.gst > 0) lines.push(journalLine(g.gst, ids.gstSuspense, side, `TPS à l'importation${suffix}`))
  }
  return lines
}

export function buildChargeJournalPayload(groups, ids, cfg) {
  const type = groups[0].type
  const apSide = type === 'credit' ? 'Debit' : 'Credit'
  const lines = buildChargeJournalLines(groups, ids)
  const total = round2(groups.reduce((s, g) => s + g.total, 0))
  const date = groups.reduce((mx, g) => (g.date > mx ? g.date : mx), groups[0].date)
  lines.push(journalLine(total, ids.ap, apSide, mergedMemo(groups), { Type: 'Vendor', EntityRef: { value: ids.vendor } }))
  // DocNumber TOUJOURS préfixé « ASFC » : contrairement à une facture (VendorRef
  // en tête, cherchable par nom de fournisseur), une JE n'a pas de fournisseur au
  // niveau transaction — seule une ligne le porte. La recherche QuickBooks
  // n'indexe pas ça de façon fiable ; le DocNumber, si.
  const docNumber = `ASFC ${groups.length === 1 && groups[0].number ? groups[0].number : date}`.slice(0, 21)
  const body = {
    TxnDate: date,
    DocNumber: docNumber,
    PrivateNote: mergedMemo(groups),
    Line: lines,
  }
  return { entity: 'journalentry', body, account_source: `fournisseur ${cfg.vendor_name} (écriture de journal)` }
}

// Regroupe les groupes « prêts » (charges ET corrections, nettées) en une seule
// facture ASFC ; les versements restent 1:1 avec la sortie bancaire réelle et
// les groupes bloqués restent visibles séparément (à ventiler d'abord).
export function mergeGroupsForPosting(groups) {
  const payments = groups.filter(g => g.type === 'paiement')
  // Charges et corrections d'un lot se nettent dans UNE facture (comme la
  // comptable : 345,10 − 79,46 − 231,13 dans la même facture). Les factures
  // passent avant les versements, qui les règlent.
  const charges = groups.filter(g => g.type !== 'paiement')
  const ready = charges.filter(g => !g.blockers.length)
  const blocked = charges.filter(g => g.blockers.length)
  const sgn = g => (g.type === 'credit' ? -1 : 1)
  const sum = k => round2(ready.reduce((t, g) => t + sgn(g) * g[k], 0))
  const out = [...blocked]
  if (ready.length) {
    const dates = ready.flatMap(g => g.lines.map(l => l.transaction_date)).sort()
    const total = sum('total')
    const merged = {
      id: ready.length === 1 ? ready[0].id : 'lot', type: total < 0 ? 'credit' : 'charge',
      date: dates[dates.length - 1], from: dates[0], number: ready.length === 1 ? ready[0].number : null,
      lines: ready.flatMap(g => g.lines),
      duty: sum('duty'), gst: sum('gst'), interest: sum('interest'), penalty: sum('penalty'), total,
      blockers: [], warnings: [], source_groups: ready,
    }
    // Facture → tout positif ; note de crédit → tout négatif. Un mélange
    // (ex. droits négatifs, TPS positive) ne s'écrit pas en un seul document.
    const parts = [merged.duty, merged.gst, merged.interest, merged.penalty].filter(v => Math.abs(v) > 0.004)
    if (parts.some(v => Math.sign(v) !== Math.sign(total))) merged.blockers.push('droits et TPS de signes opposés — ventiler à la main')
    for (const k of ['duty', 'gst', 'interest', 'penalty', 'total']) merged[k] = Math.abs(merged[k])
    if (merged.total > 0.004) out.unshift(merged)
  }
  return [...out, ...payments.sort((a, b) => a.date.localeCompare(b.date))]
}

// Facture (ou note de crédit) ASFC d'un lot : mêmes lignes que l'historique QB
// (droits portant le code TPS, sinon couple +0,01/−0,01) et taxe figée.
const fmtD = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '')
export function buildBillPayload(g, ids) {
  const credit = g.type === 'credit'
  const note = credit
    ? `Correction ASFC (du ${fmtD(g.from || g.date)} au ${fmtD(g.date)})`
    : `Pour ctb les transactions non réglées à l'ASFC (du ${fmtD(g.from || g.date)} au ${fmtD(g.date)})`
  const tax = buildGstTaxDetail(g.gst, ids)
  const body = {
    VendorRef: { value: ids.vendor },
    TxnDate: g.date,
    DocNumber: `ASFC ${g.date}`.slice(0, 21),
    PrivateNote: note,
    GlobalTaxCalculation: 'TaxExcluded',
    Line: buildChargeLines(g, ids),
    ...(tax ? { TxnTaxDetail: tax } : {}),
  }
  return { entity: credit ? 'vendorcredit' : 'bill', body, account_source: `fournisseur ASFC (${credit ? 'note de crédit' : 'facture'})` }
}

// Versement : règle d'abord les factures ASFC ouvertes (paiement de facture),
// le reste part en « Trop versé à l'ASFC » sur les Comptes fournisseurs.
export function buildPaymentPlan(g, openBills, account) {
  let left = round2(g.total)
  const applied = []
  for (const b of [...openBills].sort((x, y) => String(x.date).localeCompare(String(y.date)))) {
    if (left <= 0.004) break
    const amt = round2(Math.min(left, b.balance))
    if (amt > 0.004) { applied.push({ id: b.id, amount: amt }); left = round2(left - amt) }
  }
  const out = []
  if (applied.length) {
    const total = round2(applied.reduce((t, a) => t + a.amount, 0))
    out.push({
      entity: 'billpayment',
      body: {
        VendorRef: { value: account.vendor },
        PayType: account.isCard ? 'CreditCard' : 'Check',
        ...(account.isCard
          ? { CreditCardPayment: { CCAccountRef: { value: account.id } } }
          : { CheckPayment: { BankAccountRef: { value: account.id } } }),
        TotalAmt: total,
        TxnDate: g.date,
        PrivateNote: 'Paiement compte ASFC',
        Line: applied.map(a => ({ Amount: a.amount, LinkedTxn: [{ TxnId: String(a.id), TxnType: 'Bill' }] })),
      },
    })
  }
  if (left > 0.004) {
    out.push({
      entity: 'purchase',
      body: {
        PaymentType: account.isCard ? 'CreditCard' : 'Check',
        AccountRef: { value: account.id },
        EntityRef: { value: account.vendor, type: 'Vendor' },
        TxnDate: g.date,
        PrivateNote: 'Trop versé à l\'ASFC',
        GlobalTaxCalculation: 'NotApplicable',
        Line: [expenseLine(left, account.ap, account.noTax, 'Trop versé à l\'ASFC')],
      },
    })
  }
  return out
}

// Factures ASFC encore ouvertes dans QB (solde > 0), les plus anciennes d'abord.
async function openAsfcBills(vendorId) {
  const r = await qbRequest('GET', `/query?query=${encodeURIComponent(`select Id, TxnDate, Balance from Bill where VendorRef = '${vendorId}' and Balance > '0'`)}`)
  return (r.QueryResponse?.Bill || []).map(b => ({ id: b.Id, date: b.TxnDate, balance: Number(b.Balance) || 0 }))
}

async function paymentAccount(g, ids) {
  const { accountId, source } = paymentAccountFor(g, ids)
  const a = await qbGet(`/account/${accountId}`)
  return { id: accountId, source, isCard: a.Account?.AccountType === 'Credit Card', vendor: ids.vendor, ap: ids.ap, noTax: ids.noTax }
}

// Taxe figée : sans TaxLine explicite, QB recalcule 5 % du sous-total et le
// montant du relevé se perd. NetAmountTaxable = la valeur en douane (TPS / 5 %).
export function buildGstTaxDetail(gst, ids) {
  if (!(gst > 0)) return null
  return {
    TxnTaxCodeRef: { value: ids.tps },
    TotalTax: round2(gst),
    TaxLine: [{
      Amount: round2(gst),
      DetailType: 'TaxLineDetail',
      TaxLineDetail: {
        TaxRateRef: { value: String(ids.tpsRate) },
        PercentBased: true,
        NetAmountTaxable: round2(gst / GST_RATE),
      },
    }],
  }
}

// « ASFC » doit toujours figurer dans le mémo : c'est ce que QuickBooks
// indexe pour sa barre de recherche, et une écriture de douane introuvable
// par « ASFC » est aussi bonne que perdue (demande de Guillaume, 2026-09-01).
function memo(g) {
  if (g.type === 'paiement') return 'Paiement compte ASFC'
  const parts = []
  if (g.duty > 0) parts.push('droits de douane')
  if (g.gst > 0) parts.push('TPS à l\'importation')
  if (g.interest > 0) parts.push('intérêts')
  if (g.penalty > 0) parts.push('pénalité')
  const nature = parts.join(' et ') || KIND_LABELS[g.lines[0]?.kind] || 'douanes'
  return `${nature.charAt(0).toUpperCase()}${nature.slice(1)} — ASFC${g.number ? ` (${g.number})` : ''}`
}

// ── Résolution des comptes / codes / fournisseur (une fois par lot) ──────────
async function resolveIds(cfg) {
  const [ap, duty, interest, penalty, card, bank, gstSuspense] = await Promise.all([
    resolveAccountByAcctNum(cfg.ap_acctnum),
    resolveAccountByAcctNum(cfg.duty_acctnum),
    resolveAccountByAcctNum(cfg.interest_acctnum),
    resolveAccountByAcctNum(cfg.penalty_acctnum),
    resolveAccountByAcctNum(cfg.card_acctnum),
    resolveAccountByAcctNum(cfg.bank_acctnum),
    resolveAccountByAcctNum(cfg.gst_suspense_acctnum),
  ])
  const missing = Object.entries({ ap: cfg.ap_acctnum, duty: cfg.duty_acctnum, interest: cfg.interest_acctnum,
    penalty: cfg.penalty_acctnum, card: cfg.card_acctnum, bank: cfg.bank_acctnum, gstSuspense: cfg.gst_suspense_acctnum })
    .filter(([k]) => !({ ap, duty, interest, penalty, card, bank, gstSuspense })[k])
  if (missing.length) {
    throw new Error(`Compte QB introuvable : ${missing.map(([k, n]) => `${k} (no ${n})`).join(', ')}`
      + ' — corriger la configuration de l\'automation « Douanes ASFC »')
  }
  const codes = await resolveTaxCodeIdsByName([cfg.gst_tax_code_name, cfg.notax_tax_code_name])
  const tps = codes.get(cfg.gst_tax_code_name), noTax = codes.get(cfg.notax_tax_code_name)
  if (!tps || !noTax) throw new Error(`Code de taxe QB introuvable : ${!tps ? cfg.gst_tax_code_name : cfg.notax_tax_code_name}`)
  const { qbGet } = await import('../connectors/quickbooks.js')
  // Le taux d'achat du code n'est PAS renvoyé par une requête : GET obligatoire.
  const tc = await qbGet(`/taxcode/${tps}`)
  const tpsRate = tc.TaxCode?.PurchaseTaxRateList?.TaxRateDetail?.[0]?.TaxRateRef?.value
  if (!tpsRate) throw new Error(`Le code de taxe « ${cfg.gst_tax_code_name} » n'a pas de taux d'achat dans QuickBooks`)
  const vendor = await findOrCreateVendor(cfg.vendor_name)
  return { ap, duty, interest, penalty, card, bank, gstSuspense, tps, noTax, tpsRate, vendor }
}

// Compte de paiement d'un versement : celui de la sortie bancaire correspondante
// quand on la retrouve (le relevé bancaire est la source de vérité), sinon la
// carte configurée.
function paymentAccountFor(g, ids) {
  const total = g.total
  const hit = db.prepare(`
    SELECT ba.qb_account_id, ba.name, bt.txn_date FROM bank_transactions bt
    JOIN bank_accounts ba ON ba.id = bt.account_id
    WHERE bt.deleted_at IS NULL AND ba.qb_account_id IS NOT NULL AND bt.amount < 0
      AND ABS(ABS(bt.amount) - ?) < 0.005
      AND ABS(julianday(bt.txn_date) - julianday(?)) <= 10
      AND (LOWER(bt.description) LIKE '%cbsa%' OR LOWER(bt.description) LIKE '%asfc%'
           OR LOWER(bt.description) LIKE '%border services%' OR LOWER(bt.description) LIKE '%frontalier%')
    ORDER BY ABS(julianday(bt.txn_date) - julianday(?)) LIMIT 1
  `).get(total, g.date, g.date)
  const id = mainQbAccount(hit)
  return { accountId: id || ids.card, source: id ? `relevé bancaire (${hit.name})` : 'carte configurée' }
}

export function buildPayload(g, ids, cfg) {
  if (g.type === 'paiement') {
    const { accountId, source } = paymentAccountFor(g, ids)
    return {
      entity: 'purchase', account_source: source,
      body: {
        PaymentType: 'CreditCard',
        AccountRef: { value: accountId },
        EntityRef: { value: ids.vendor, type: 'Vendor' },
        TxnDate: g.date,
        PrivateNote: memo(g),
        GlobalTaxCalculation: 'NotApplicable',
        Line: [expenseLine(g.total, ids.ap, ids.noTax, 'Paiement à l\'ASFC')],
      },
    }
  }
  return buildBillPayload(g, ids, cfg)
}

// ── Aperçu et exécution ──────────────────────────────────────────────────────

// L'écriture telle qu'elle tombera au grand livre : document QB → lignes
// débit / crédit, comptes nommés. Ce que l'utilisateur contrôle avant d'engager.
const DOC_TITLES = { bill: 'Facture fournisseur', vendorcredit: 'Note de crédit fournisseur', billpayment: 'Paiement de facture', purchase: 'Dépense' }
export function describeEntry(doc, ids, cfg, accountName = id => `compte ${id}`) {
  const b = doc.body
  const rows = []
  const add = (account, description, amount, debit) => {
    const a = round2(amount)
    if (Math.abs(a) < 0.005) return
    const dr = a < 0 ? !debit : debit
    rows.push({ account, description, debit: dr ? Math.abs(a) : null, credit: dr ? null : Math.abs(a) })
  }
  const ap = `${accountName(ids.ap)} · ${cfg.vendor_name}`
  const expense = l => accountName(l.AccountBasedExpenseLineDetail.AccountRef.value)
  if (doc.entity === 'bill' || doc.entity === 'vendorcredit') {
    const dr = doc.entity === 'bill'
    for (const l of b.Line) add(expense(l), l.Description, l.Amount, dr)
    const tax = Number(b.TxnTaxDetail?.TotalTax) || 0
    add('TPS à recouvrer (CTI)', 'TPS à l\'importation', tax, dr)
    add(ap, null, b.Line.reduce((t, l) => t + l.Amount, 0) + tax, !dr)
  } else if (doc.entity === 'billpayment') {
    add(ap, `${b.Line.length} facture(s) ASFC réglée(s)`, b.TotalAmt, true)
    add(accountName(b.CreditCardPayment?.CCAccountRef.value || b.CheckPayment?.BankAccountRef.value), null, b.TotalAmt, false)
  } else if (doc.entity === 'purchase') {
    for (const l of b.Line) add(l.AccountBasedExpenseLineDetail.AccountRef.value === ids.ap ? ap : expense(l), l.Description, l.Amount, true)
    add(accountName(b.AccountRef.value), null, b.Line.reduce((t, l) => t + l.Amount, 0), false)
  }
  return { title: DOC_TITLES[doc.entity] || doc.entity, date: b.TxnDate, number: b.DocNumber || null, memo: b.PrivateNote || null, rows }
}

async function accountNamer() {
  let cache = null
  try { cache = await loadAccountsCache() } catch { /* noms indisponibles : on montre l'Id */ }
  return id => {
    const a = cache?.byId.get(String(id))
    return a ? [a.acctNum, a.name].filter(Boolean).join(' ') : `compte ${id}`
  }
}

function postableLines() {
  return db.prepare(`
    SELECT id, transaction_date, transaction_number, transaction_type, description, detail, amount,
           kind, payer, broker, duty_amount, gst_amount, posting_state, qb_txn_id
    FROM carm_transactions WHERE deleted_at IS NULL ORDER BY transaction_date, created_at
  `).all()
}

// ── Déjà saisi à la main dans QuickBooks ? ──────────────────────────────────
// Avant de proposer quoi que ce soit, on relit les documents du fournisseur
// ASFC : une ligne déjà couverte n'est jamais écrite deux fois.
//   • charge → facture / note de crédit dont le mémo couvre sa date
//     (« … (du 01/05/2026 au 31/07/2026) », format de la comptable) ;
//   • versement → paiement de facture et/ou dépense ASFC du même montant
//     total, à 5 jours près (ex. 267,12 + 232,88 = 500 $ du 3 août).
const parseD = d => (d ? `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : null)
export function matchExistingQb(lines, docs) {
  const links = new Map() // line id → [{ entity, id }]
  const free = lines.filter(l => l.posting_state === 'a_comptabiliser')
  const periods = docs.filter(d => d.entity === 'bill' || d.entity === 'vendorcredit').map(d => {
    const m = String(d.note || '').match(/du (\d{2}\/\d{2}\/\d{4}) au (\d{2}\/\d{2}\/\d{4})/)
    return m ? { ...d, from: parseD(m[1]), to: parseD(m[2]) } : null
  }).filter(Boolean)
  for (const l of free.filter(x => x.kind !== 'paiement')) {
    const hit = periods.find(d => l.transaction_date >= d.from && l.transaction_date <= d.to)
    if (hit) links.set(l.id, [{ entity: hit.entity, id: hit.id }])
  }
  const pays = docs.filter(d => d.entity === 'billpayment' || d.entity === 'purchase')
  const used = new Set()
  const byGroup = new Map()
  for (const l of free.filter(x => x.kind === 'paiement' && x.payer !== 'courtier')) {
    const k = `${l.transaction_date}|${l.transaction_number || l.id}`
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k).push(l)
  }
  for (const group of byGroup.values()) {
    const total = round2(group.reduce((t, l) => t - l.amount, 0))
    const near = pays.filter(d => !used.has(d.id) && daysApart(d.date, group[0].transaction_date) <= 5)
    let hit = near.filter(d => Math.abs(d.total - total) < 0.005).slice(0, 1)
    if (!hit.length) {
      for (const a of near) {
        const b = near.find(x => x !== a && x.date === a.date && Math.abs(a.total + x.total - total) < 0.005)
        if (b) { hit = [a, b]; break }
      }
    }
    if (!hit.length) continue
    hit.forEach(d => used.add(d.id))
    for (const l of group) links.set(l.id, hit.map(d => ({ entity: d.entity, id: d.id })))
  }
  return links
}
const daysApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000)

async function asfcDocs(vendorId, since) {
  const out = []
  const ask = async (entity, cols) => {
    const r = await qbRequest('GET', `/query?query=${encodeURIComponent(`select ${cols} from ${entity} where TxnDate >= '${since}' MAXRESULTS 1000`)}`)
    return r.QueryResponse?.[entity] || []
  }
  for (const b of await ask('Bill', '*')) if (b.VendorRef?.value === vendorId) out.push({ entity: 'bill', id: b.Id, date: b.TxnDate, total: Number(b.TotalAmt), note: b.PrivateNote })
  for (const b of await ask('VendorCredit', '*')) if (b.VendorRef?.value === vendorId) out.push({ entity: 'vendorcredit', id: b.Id, date: b.TxnDate, total: Number(b.TotalAmt), note: b.PrivateNote })
  for (const b of await ask('BillPayment', '*')) if (b.VendorRef?.value === vendorId) out.push({ entity: 'billpayment', id: b.Id, date: b.TxnDate, total: Number(b.TotalAmt), note: b.PrivateNote })
  for (const b of await ask('Purchase', '*')) if (b.EntityRef?.value === vendorId) out.push({ entity: 'purchase', id: b.Id, date: b.TxnDate, total: Number(b.TotalAmt), note: b.PrivateNote })
  return out
}

// Relie aux documents QB existants les lignes déjà saisies (à la main ou par
// une version précédente) ; elles passent « comptabilisé » sans rien créer.
export async function linkExistingQb(ids) {
  const lines = postableLines().filter(l => l.posting_state === 'a_comptabiliser')
  if (!lines.length) return 0
  const first = lines.reduce((m, l) => (l.transaction_date < m ? l.transaction_date : m), lines[0].transaction_date)
  const since = new Date(Date.parse(first) - 15 * 86400000).toISOString().slice(0, 10)
  const links = matchExistingQb(lines, await asfcDocs(ids.vendor, since))
  const upd = db.prepare(`
    UPDATE carm_transactions SET posting_state = 'comptabilise', qb_txn_id = ?, qb_txn_type = ?,
      posting_group = ?, posting_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL AND posting_state = 'a_comptabiliser'
  `)
  const tx = db.transaction(() => {
    for (const [lineId, docs] of links) {
      upd.run(docs[0].id, docs[0].entity, `existant:${docs.map(d => `${d.entity}:${d.id}`).join(',')}`, lineId)
    }
  })
  tx()
  return links.size
}

export async function previewCarmPostings() {
  const cfg = getCarmConfig()
  let ids = null, error = null, already = 0
  try { ids = await resolveIds(cfg) } catch (e) { error = e.message }
  if (ids) { try { already = await linkExistingQb(ids) } catch (e) { error = `Lecture QuickBooks : ${e.message}` } }
  const groups = mergeGroupsForPosting(buildPostingGroups(postableLines()))
  const accountName = ids ? await accountNamer() : null
  const out = groups.map(g => {
    const view = {
      id: g.id, type: g.type, date: g.date, number: g.number, total: g.total,
      duty: g.duty, gst: g.gst, interest: g.interest, penalty: g.penalty,
      declarations: g.source_groups ? g.source_groups.length : 1,
      line_ids: g.lines.map(l => l.id),
      labels: g.lines.map(l => `${KIND_LABELS[l.kind] || l.kind} ${Math.abs(l.amount).toFixed(2)} $`),
      blockers: [...g.blockers], warnings: [...g.warnings],
    }
    if (ids && g.type !== 'paiement') {
      const p = buildPayload(g, ids, cfg)
      view.entity = p.entity
      view.account_source = p.account_source
      view.payload = p.body
      view.entries = [describeEntry(p, ids, cfg, accountName)]
    }
    return view
  })
  // Versements : ce qu'ils régleront (factures ouvertes + lot en cours) et le surplus.
  if (ids) {
    let open = []
    try { open = await openAsfcBills(ids.vendor) } catch { /* aperçu sans QB */ }
    const pending = groups.find(g => g.type === 'charge' && !g.blockers.length)
    if (pending) open.push({ id: 'nouvelle', date: pending.date, balance: pending.total })
    for (const v of out.filter(x => x.type === 'paiement')) {
      const g = groups.find(x => x.id === v.id)
      const { accountId } = paymentAccountFor(g, ids)
      const plan = buildPaymentPlan(g, open, { id: accountId, isCard: true, vendor: ids.vendor, ap: ids.ap, noTax: ids.noTax })
      v.entries = plan.map(p => describeEntry(p, ids, cfg, accountName))
      const paid = plan.find(p => p.entity === 'billpayment')?.body.TotalAmt || 0
      const extra = plan.find(p => p.entity === 'purchase')?.body.Line[0].Amount || 0
      v.entity = paid ? 'billpayment' : 'purchase'
      v.account_source = [paid && `règle ${paid.toFixed(2)} $ de factures`, extra && `${extra.toFixed(2)} $ en trop-versé`].filter(Boolean).join(' · ')
      for (const b of open) {
        const a = plan.find(p => p.entity === 'billpayment')?.body.Line.find(l => l.LinkedTxn[0].TxnId === String(b.id))
        if (a) b.balance = round2(b.balance - a.Amount)
      }
    }
  }
  const max = Number(cfg.max_batch) || 50
  return {
    groups: out,
    ready: out.filter(g => !g.blockers.length).length,
    blocked: out.filter(g => g.blockers.length).length,
    max_batch: max,
    already_in_qb: already,
    config_error: error,
  }
}

// Pousse les groupes demandés (tous les groupes prêts par défaut). Un groupe en
// échec n'arrête pas le lot ; ses lignes passent en « erreur » avec le message.
// `trigger` respecte la contrainte de sync_log : 'manual' | 'scheduled' | 'webhook'.
export async function postCarmGroups({ groupIds = null, userId = null, trigger = 'manual' } = {}) {
  const t0 = Date.now()
  const cfg = getCarmConfig()
  const ids = await resolveIds(cfg)
  await linkExistingQb(ids)
  const all = mergeGroupsForPosting(buildPostingGroups(postableLines()))
  const max = Number(cfg.max_batch) || 50
  const wanted = all
    .filter(g => (!groupIds || groupIds.includes(g.id)) && !g.blockers.length)
    .slice(0, max)

  const markPosted = db.prepare(`
    UPDATE carm_transactions SET posting_state = 'comptabilise', qb_txn_id = ?, qb_txn_type = ?,
      posting_group = ?, posting_error = NULL,
      qb_pushed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL
  `)
  const markError = db.prepare(`
    UPDATE carm_transactions SET posting_state = 'erreur', posting_error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL
  `)
  const stillFree = db.prepare(`
    SELECT COUNT(*) AS n FROM carm_transactions
    WHERE id = ? AND deleted_at IS NULL AND qb_txn_id IS NULL AND posting_state = 'a_comptabiliser'
  `)

  const results = []
  for (const g of wanted) {
    // Relecture juste avant l'appel : jamais deux écritures pour la même ligne.
    if (g.lines.some(l => stillFree.get(l.id).n === 0)) {
      results.push({ id: g.id, skipped: 'déjà comptabilisé' })
      continue
    }
    let entity
    try {
      const docs = g.type === 'paiement'
        ? buildPaymentPlan(g, await openAsfcBills(ids.vendor), await paymentAccount(g, ids))
        : [buildPayload(g, ids, cfg)]
      const made = []
      for (const d of docs) {
        const r = await qbPost(`/${d.entity}`, d.body)
        const txnId = r[QB_ENTITY_KEY[d.entity]]?.Id
        if (!txnId) throw new Error(`QuickBooks n'a pas retourné d'Id pour ${d.entity}`)
        made.push({ entity: d.entity, id: String(txnId) })
      }
      // La ligne pointe le premier document ; posting_group garde tous les
      // documents créés (paiement de facture + trop-versé) pour l'annulation.
      entity = made[0].entity
      const txnId = made[0].id
      const group = made.map(m => `${m.entity}:${m.id}`).join(',')
      const tx = db.transaction(() => {
        for (const l of g.lines) markPosted.run(txnId, entity, group, l.id)
      })
      tx()
      results.push({ id: g.id, entity, qb_txn_id: txnId, total: g.total })
    } catch (e) {
      const tx = db.transaction(() => { for (const l of g.lines) markError.run(e.message, l.id) })
      tx()
      results.push({ id: g.id, entity, error: e.message })
    }
  }
  const posted = results.filter(r => r.qb_txn_id).length
  const failed = results.filter(r => r.error).length
  logSync('carm-qb', trigger, {
    status: failed ? 'error' : 'success',
    modified: posted,
    error: failed ? results.find(r => r.error).error : null,
    durationMs: Date.now() - t0,
  })
  return { posted, failed, skipped: results.filter(r => r.skipped).length, results, user_id: userId }
}

// Annule une écriture déjà comptabilisée : supprime la transaction QuickBooks
// et remet les lignes qu'elle couvrait en 'a_comptabiliser' (elles repartiront
// au prochain push, avec la logique de comptabilisation en vigueur au moment
// du nouveau push). Sert à corriger une écriture posée avec une ancienne
// version des règles de comptabilisation (ex. facture fournisseur → JE).
const QB_ENTITY_KEY = { purchase: 'Purchase', journalentry: 'JournalEntry', bill: 'Bill', vendorcredit: 'VendorCredit', billpayment: 'BillPayment' }

export async function unpostCarmGroup(qbTxnId) {
  const rows = db.prepare(`
    SELECT id, qb_txn_type, posting_group FROM carm_transactions WHERE qb_txn_id = ? AND deleted_at IS NULL
  `).all(String(qbTxnId))
  if (!rows.length) throw new Error('Aucune ligne comptabilisée avec cet identifiant QuickBooks')
  // Lignes reliées à une saisie manuelle : on délie seulement, on ne supprime
  // jamais dans QB ce que Boréal n'a pas créé.
  if (String(rows[0].posting_group || '').startsWith('existant:')) {
    const reset = db.prepare(`UPDATE carm_transactions SET posting_state = 'a_comptabiliser', qb_txn_id = NULL, qb_txn_type = NULL, posting_group = NULL WHERE id = ?`)
    db.transaction(() => { for (const r of rows) reset.run(r.id) })()
    return rows.length
  }
  const docs = String(rows[0].posting_group || '').split(',').map(x => x.split(':'))
    .filter(([e, id]) => QB_ENTITY_KEY[e] && id)
  if (!docs.some(([, id]) => id === String(qbTxnId))) docs.unshift([rows[0].qb_txn_type, String(qbTxnId)])
  // Le paiement d'abord (il bloque la suppression de la facture qu'il règle).
  docs.sort(([a], [b]) => (a === 'billpayment' ? -1 : b === 'billpayment' ? 1 : 0))
  for (const [entity, id] of docs) {
    const key = QB_ENTITY_KEY[entity]
    if (!key) throw new Error(`Type de transaction QuickBooks inconnu : ${entity}`)
    let current = null
    try { current = await qbGet(`/${entity}/${id}`) } catch { current = null }
    const syncToken = current?.[key]?.SyncToken
    // Déjà supprimée dans QB (ex. refaite à la main) : rien à défaire.
    if (syncToken == null) continue
    await qbRequest('POST', `/${entity}?operation=delete`, { Id: String(id), SyncToken: syncToken })
  }
  const upd = db.prepare(`
    UPDATE carm_transactions SET posting_state = 'a_comptabiliser', qb_txn_id = NULL, qb_txn_type = NULL,
      posting_group = NULL, posting_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `)
  const tx = db.transaction(() => { for (const r of rows) upd.run(r.id) })
  tx()
  return rows.length
}
