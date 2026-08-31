// Écritures QuickBooks du compte ASFC.
//
// Le compte ASFC EST le solde du fournisseur « ASFC » dans les Comptes
// fournisseurs (21000) — pas de compte de passage à créer, rien dans les frais
// payés d'avance, et la fiche fournisseur QB reproduit le relevé du portail :
//   • notre versement  → Dépense sur la carte, une ligne imputée à 21000 ;
//   • charge (B3, C1, intérêts, pénalité) → Facture fournisseur ASFC : droits en
//     coût (65000) et TPS à l'importation en CTI 100 % récupérable ;
//   • correction créditrice → Note de crédit fournisseur (même ventilation) ;
//   • ligne réglée par un courtier → rien (sa facture porte déjà tout).
// Le crédit laissé au portail (202,68 $ le 2026-08-03) tombe tout seul : le
// versement dépasse les factures, le fournisseur ASFC est débiteur d'autant.
//
// SONDÉ SUR LE VRAI FICHIER QB (2026-08-22, transactions créées puis supprimées) :
//   1. une ligne de dépense imputée aux Comptes fournisseurs avec EntityRef
//      fournisseur est ACCEPTÉE (c'est l'avance au compte ASFC) ;
//   2. une facture 100 % TPS passe avec l'astuce +0,01 [TPS] / −0,01 [Hors champ]
//      et TotalTax explicite (total = la TPS, comme dans l'historique QB) ;
//   3. le TaxLine TPS n'est accepté QUE si au moins une ligne porte le code TPS —
//      une facture dont toutes les lignes sont « Hors champ » est rejetée
//      (« Invalid tax rate id »). La ligne de droits porte donc le code TPS et
//      le montant de taxe est figé par TaxLine (sinon QB recalcule 5 %).
import db from '../db/database.js'
import { qbPost } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum, resolveTaxCodeIdsByName, findOrCreateVendor } from './quickbooks.js'
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

// ── Fusion des charges/notes de crédit d'un même push ────────────────────────
// Plusieurs B3 (ou notes de crédit) dans un même relevé partaient chacun dans
// leur propre Facture fournisseur — pénible à valider un par un dans QB. On
// les fusionne en une seule écriture multi-lignes (une ligne par déclaration
// et par nature), avec un seul TaxLine porté sur la TPS totale du lot.
function buildMergedChargeLines(groups, ids) {
  const lines = []
  let tpsCoded = false
  for (const g of groups) {
    const suffix = g.number ? ` — ${g.number}` : ''
    if (g.duty > 0) {
      const code = g.gst > 0 ? ids.tps : ids.noTax
      if (code === ids.tps) tpsCoded = true
      lines.push(expenseLine(g.duty, ids.duty, code, `Droits de douane${suffix}`))
    }
    if (g.interest > 0) lines.push(expenseLine(g.interest, ids.interest, ids.noTax, `Intérêts${suffix}`))
    if (g.penalty > 0) lines.push(expenseLine(g.penalty, ids.penalty, ids.noTax, `Pénalité${suffix}`))
  }
  const gstTotal = round2(groups.reduce((s, g) => s + g.gst, 0))
  if (gstTotal > 0 && !tpsCoded) lines.push(...buildGstOnlyLines(ids.duty, ids.tps, ids.noTax))
  return { lines, gstTotal }
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

export function buildMergedChargePayload(groups, ids, cfg) {
  const type = groups[0].type
  const { lines, gstTotal } = buildMergedChargeLines(groups, ids)
  const tax = buildGstTaxDetail(gstTotal, ids)
  const date = groups.reduce((mx, g) => (g.date > mx ? g.date : mx), groups[0].date)
  const body = {
    VendorRef: { value: ids.vendor },
    APAccountRef: { value: ids.ap },
    TxnDate: date,
    DocNumber: groups.length === 1 && groups[0].number ? String(groups[0].number).slice(0, 21) : undefined,
    PrivateNote: mergedMemo(groups),
    GlobalTaxCalculation: 'TaxExcluded',
    Line: lines,
    ...(tax ? { TxnTaxDetail: tax } : {}),
  }
  return { entity: type === 'credit' ? 'vendorcredit' : 'bill', body, account_source: `fournisseur ${cfg.vendor_name}` }
}

// Regroupe les groupes « prêts » de même nature (charge / note de crédit) en
// une seule unité de comptabilisation ; les versements restent 1:1 avec la
// sortie bancaire réelle et les groupes bloqués restent visibles séparément
// (à ventiler avant de rejoindre le lot fusionné).
export function mergeGroupsForPosting(groups) {
  const mergeType = type => {
    const ready = groups.filter(g => g.type === type && !g.blockers.length)
    const blocked = groups.filter(g => g.type === type && g.blockers.length)
    if (ready.length < 2) return [...ready, ...blocked]
    const merged = {
      id: `${type}-merged`, type, date: ready.reduce((mx, g) => (g.date > mx ? g.date : mx), ready[0].date),
      number: null,
      lines: ready.flatMap(g => g.lines),
      duty: round2(ready.reduce((s, g) => s + g.duty, 0)),
      gst: round2(ready.reduce((s, g) => s + g.gst, 0)),
      interest: round2(ready.reduce((s, g) => s + g.interest, 0)),
      penalty: round2(ready.reduce((s, g) => s + g.penalty, 0)),
      total: round2(ready.reduce((s, g) => s + g.total, 0)),
      blockers: [], warnings: [],
      source_groups: ready,
    }
    return [merged, ...blocked]
  }
  const payments = groups.filter(g => g.type === 'paiement')
  return [...mergeType('charge'), ...mergeType('credit'), ...payments]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
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

function memo(g) {
  if (g.type === 'paiement') return 'Paiement compte ASFC'
  const parts = []
  if (g.duty > 0) parts.push('droits de douane')
  if (g.gst > 0) parts.push('TPS à l\'importation')
  if (g.interest > 0) parts.push('intérêts')
  if (g.penalty > 0) parts.push('pénalité')
  const nature = parts.join(' et ') || KIND_LABELS[g.lines[0]?.kind] || 'douanes'
  return `${nature.charAt(0).toUpperCase()}${nature.slice(1)}${g.number ? ` — ${g.number}` : ''}`
}

// ── Résolution des comptes / codes / fournisseur (une fois par lot) ──────────
async function resolveIds(cfg) {
  const [ap, duty, interest, penalty, card, bank] = await Promise.all([
    resolveAccountByAcctNum(cfg.ap_acctnum),
    resolveAccountByAcctNum(cfg.duty_acctnum),
    resolveAccountByAcctNum(cfg.interest_acctnum),
    resolveAccountByAcctNum(cfg.penalty_acctnum),
    resolveAccountByAcctNum(cfg.card_acctnum),
    resolveAccountByAcctNum(cfg.bank_acctnum),
  ])
  const missing = Object.entries({ ap: cfg.ap_acctnum, duty: cfg.duty_acctnum, interest: cfg.interest_acctnum,
    penalty: cfg.penalty_acctnum, card: cfg.card_acctnum, bank: cfg.bank_acctnum })
    .filter(([k]) => !({ ap, duty, interest, penalty, card, bank })[k])
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
  return { ap, duty, interest, penalty, card, bank, tps, noTax, tpsRate, vendor }
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
  const id = hit?.qb_account_id && !String(hit.qb_account_id).includes(',') ? String(hit.qb_account_id) : null
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
  if (g.source_groups) return buildMergedChargePayload(g.source_groups, ids, cfg)
  const lines = buildChargeLines(g, ids)
  const tax = buildGstTaxDetail(g.gst, ids)
  const body = {
    VendorRef: { value: ids.vendor },
    APAccountRef: { value: ids.ap },
    TxnDate: g.date,
    DocNumber: g.number ? String(g.number).slice(0, 21) : undefined,
    PrivateNote: memo(g),
    GlobalTaxCalculation: 'TaxExcluded',
    Line: lines,
    ...(tax ? { TxnTaxDetail: tax } : {}),
  }
  return { entity: g.type === 'credit' ? 'vendorcredit' : 'bill', body, account_source: `fournisseur ${cfg.vendor_name}` }
}

// ── Aperçu et exécution ──────────────────────────────────────────────────────

function postableLines() {
  return db.prepare(`
    SELECT id, transaction_date, transaction_number, transaction_type, description, detail, amount,
           kind, payer, broker, duty_amount, gst_amount, posting_state, qb_txn_id
    FROM carm_transactions WHERE deleted_at IS NULL ORDER BY transaction_date, created_at
  `).all()
}

export async function previewCarmPostings() {
  const cfg = getCarmConfig()
  const groups = mergeGroupsForPosting(buildPostingGroups(postableLines()))
  let ids = null, error = null
  try { ids = await resolveIds(cfg) } catch (e) { error = e.message }
  const out = groups.map(g => {
    const view = {
      id: g.id, type: g.type, date: g.date, number: g.number, total: g.total,
      duty: g.duty, gst: g.gst, interest: g.interest, penalty: g.penalty,
      declarations: g.source_groups ? g.source_groups.length : 1,
      line_ids: g.lines.map(l => l.id),
      labels: g.lines.map(l => `${KIND_LABELS[l.kind] || l.kind} ${Math.abs(l.amount).toFixed(2)} $`),
      blockers: [...g.blockers], warnings: [...g.warnings],
    }
    if (ids) {
      const p = buildPayload(g, ids, cfg)
      view.entity = p.entity
      view.account_source = p.account_source
      view.payload = p.body
    }
    return view
  })
  const max = Number(cfg.max_batch) || 50
  return {
    groups: out,
    ready: out.filter(g => !g.blockers.length).length,
    blocked: out.filter(g => g.blockers.length).length,
    max_batch: max,
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
    const { entity, body } = buildPayload(g, ids, cfg)
    try {
      const r = await qbPost(`/${entity}`, body)
      const key = entity === 'purchase' ? 'Purchase' : entity === 'bill' ? 'Bill' : 'VendorCredit'
      const txnId = r[key]?.Id
      if (!txnId) throw new Error(`QuickBooks n'a pas retourné d'Id pour ${entity}`)
      const tx = db.transaction(() => {
        for (const l of g.lines) markPosted.run(String(txnId), entity, g.id, l.id)
      })
      tx()
      results.push({ id: g.id, entity, qb_txn_id: String(txnId), total: g.total })
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
