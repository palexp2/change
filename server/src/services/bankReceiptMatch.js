// ── Retrouver LA pièce qu'un débit paie ─────────────────────────────────────
// Le débit arrive au relevé sans rien dire de la facture qui lui correspond,
// alors que la pièce dort souvent déjà dans l'extracteur ou dans les achats
// (demande de Charles, 2026-09-19 : « plusieurs sont là mais pas détectées »).
// L'ancien filtre exigeait le montant au cent près, dans les 7 jours, dans la
// devise du compte : il laissait passer les deux tiers des cas — facture nette
// 30, achat en USD débité en CAD, pourboire ou frais de carte ajoutés.
//
// Ici rien n'est exigé : chaque pièce repart avec une note et ses raisons en
// clair. La certitude ne vient jamais du montant seul — c'est le nom du
// fournisseur écrit au relevé qui tranche — et une candidate mal détachée de
// la suivante n'est jamais déclarée « sûre ».
import db from '../db/database.js'
import { usdCadRateLookup } from './fx.js'
import {
  AMOUNT_EPS, normalizeText, bestNameMatch, containsCompact, bankText, daysBetween, round2,
  governmentLabelHit,
} from './textMatch.js'

const WINDOW_DAYS = 120
// Le filet SQL est plus large que le barème : la tolérance de 1 % doit rester
// atteignable, et la recherche libre de l'humain doit avoir de la matière.
const POOL_TOL_PCT = 0.02
const POOL_TOL_ABS = 2

function shift(date, days) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function jsonList(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter(Boolean).map(String) : []
  } catch { return [] }
}

// Le montant de la pièce vu dans la devise du compte.
export function convertAmount(total, docCurrency, accountCurrency, rate) {
  const doc = (docCurrency || 'CAD').toUpperCase()
  const acct = (accountCurrency || 'CAD').toUpperCase()
  if (doc === acct) return Math.abs(Number(total) || 0)
  if (!rate) return null
  if (doc === 'USD' && acct === 'CAD') return round2(Math.abs(total) * rate)
  if (doc === 'CAD' && acct === 'USD') return round2(Math.abs(total) / rate)
  return null
}

// Le « montant initial en devise USD 105,00 » que la BNC écrit sous un achat
// en devise : c'est le total de la facture, avant tout taux et tout frais.
// Colonnes remplies à l'import si possible, sinon relu dans le libellé.
export function parseOrigAmount(txn) {
  const cur = String(txn?.orig_currency || '').toUpperCase()
  const amt = Math.abs(Number(txn?.orig_amount))
  if (/^[A-Z]{3}$/.test(cur) && amt > 0) return { currency: cur, amount: round2(amt) }
  const m = bankText(txn).match(/montant\s+initial\s+en\s+devise\s+([A-Z]{3})\s*-?\s*(\d[\d\s\u00a0.]*(?:,\d{1,2})?)/i)
  if (!m) return null
  const n = Number(m[2].replace(/[\s\u00a0.]/g, '').replace(',', '.'))
  return n > 0 ? { currency: m[1].toUpperCase(), amount: round2(n) } : null
}

// Les cartes ajoutent ~2,5 % au taux du jour sur un achat en devise.
const CARD_FX_FEE = 0.025
function conversionBand(converted, amountAbs) {
  if (!(converted > 0)) return null
  const gap = Math.abs(converted - amountAbs)
  // Le taux de la Banque du Canada n'est pas celui de la carte : l'écart normal
  // est de quelques dixièmes de pourcent, d'où une bande plus large qu'au cent
  // près.
  if (gap <= Math.max(0.5, amountAbs * 0.005)) return 'exact'
  const ratio = amountAbs / converted
  if (ratio >= 1 + CARD_FX_FEE - 0.01 && ratio <= 1 + CARD_FX_FEE + 0.01) return 'frais'
  if (gap <= amountAbs * 0.025) return 'proche'
  return null
}

// Le sens de l'argent tranche avant toute note : une sortie se paie par une
// pièce positive (facture), une entrée par une pièce négative (remboursement,
// note de crédit, avis de cotisation). Demande de Charles, 2026-09-22 : le
// remboursement d'impôt dormait dans l'extracteur sans jamais être proposé.
export function signCompatible(txnAmount, docTotal) {
  const a = Number(txnAmount) || 0
  const t = Number(docTotal) || 0
  if (a < 0) return t >= 0
  if (a > 0) return t < 0
  return false
}

// ── Le barème ────────────────────────────────────────────────────────────────

function scoreAmount(amountAbs, doc, ctx) {
  const total = Math.abs(Number(doc.total) || 0)
  const charged = Number(doc.bank_charged_total)
  const sameCurrency = (doc.currency || 'CAD').toUpperCase() === (ctx.accountCurrency || 'CAD').toUpperCase()

  // Le montant que l'humain a lui-même relevé au compte pour cette pièce :
  // c'est la banque qui parle, pas une estimation de taux.
  if (Number.isFinite(charged) && charged > 0 && Math.abs(Math.abs(charged) - amountAbs) <= AMOUNT_EPS) {
    return { pts: 55, reason: 'montant débité au compte' }
  }
  // Le relevé écrit lui-même le montant d'origine : s'il égale la pièce, peu
  // importe la devise qu'on lui a prêtée à la lecture.
  if (ctx.orig && total > 0 && Math.abs(ctx.orig.amount - total) <= AMOUNT_EPS) {
    return { pts: 52, reason: `montant initial ${ctx.orig.currency} au relevé` }
  }
  if (sameCurrency) {
    if (Math.abs(total - amountAbs) <= AMOUNT_EPS) return { pts: 50, reason: 'montant exact' }
    if (total > 0 && Math.abs(total - amountAbs) <= Math.max(1, total * 0.01)) {
      return { pts: 18, reason: `écart de ${round2(Math.abs(total - amountAbs))} $` }
    }
    // Pièce notée CAD sur un compte CAD mais qui, lue en USD, tombe sur le
    // débit : l'extraction a sans doute prêté au « $ » la devise du compte.
    if ((ctx.accountCurrency || 'CAD').toUpperCase() === 'CAD' && ctx.rate) {
      const band = conversionBand(convertAmount(total, 'USD', 'CAD', ctx.rate), amountAbs)
      if (band === 'exact') return { pts: 34, reason: 'pièce sans doute en USD' }
      if (band === 'frais') return { pts: 26, reason: 'pièce sans doute en USD + frais de change' }
    }
    if (amountAbs > total) return { pts: 0, reason: 'le débit dépasse la pièce' }
    return { pts: 0, reason: 'montant différent' }
  }
  const converted = convertAmount(total, doc.currency, ctx.accountCurrency, ctx.rate)
  if (converted == null) return { pts: 0, reason: 'taux de change indisponible' }
  // 10 points de moins qu'au cent près : la conversion reste une hypothèse.
  const band = conversionBand(converted, amountAbs)
  if (band === 'exact') return { pts: 40, reason: `montant exact une fois converti (≈ ${ctx.rate})` }
  if (band === 'frais') return { pts: 32, reason: 'converti + ~2,5 % de frais de change' }
  if (band === 'proche') return { pts: 14, reason: 'montant proche une fois converti' }
  return { pts: 0, reason: 'montant différent' }
}

function scoreVendor(doc, ctx) {
  for (const p of doc.patterns || []) {
    if (p && normalizeText(ctx.text).includes(normalizeText(p))) {
      return { pts: 45, reason: 'motif du profil fournisseur au relevé', hit: true }
    }
  }
  if (governmentLabelHit(doc.names, ctx.text)) {
    return { pts: 45, reason: 'libellé gouvernemental au relevé', hit: true }
  }
  const nm = bestNameMatch(doc.names, ctx.text)
  if (nm.ratio >= 0.5 || nm.hits >= 2) return { pts: 45, reason: 'fournisseur au relevé', hit: true }
  if ((doc.names || []).some(n => containsCompact(ctx.text, n))) {
    return { pts: 45, reason: 'fournisseur au relevé', hit: true }
  }
  if (nm.hits >= 1) return { pts: 22, reason: 'fournisseur proche', hit: false }
  return { pts: 0, reason: null, hit: false }
}

function scoreDates(doc, txnDate) {
  let best = null
  for (const [label, date] of [['date de la pièce', doc.date], ['date de commande', doc.order_date], ['échéance', doc.due_date]]) {
    if (!date) continue
    const gap = daysBetween(date, txnDate)
    if (gap == null) continue
    let pts
    if (gap < -3) pts = -25
    else if (gap < 0) pts = 6
    else if (gap <= 2) pts = 18
    else if (gap <= 7) pts = 12
    else if (gap <= 45) pts = 8
    else if (gap <= WINDOW_DAYS) pts = 3
    else pts = 0
    if (!best || pts > best.pts) best = { pts, gap, label }
  }
  if (!best) return { pts: 0, reason: null }
  if (best.pts === -25) return { pts: -25, reason: 'pièce postérieure au débit' }
  if (best.gap <= 7) return { pts: best.pts, reason: null }
  return { pts: best.pts, reason: `${best.label} il y a ${best.gap} jours` }
}

// Note d'une pièce face à une ligne de relevé. Pure : aucun accès à la base,
// tout ce qu'elle sait est dans `doc` et `ctx`.
export function scoreDoc(txn, doc, ctx) {
  const reasons = []
  const amountAbs = Math.abs(Number(txn.amount) || 0)
  let score = 0

  const amt = scoreAmount(amountAbs, doc, ctx)
  score += amt.pts
  if (amt.reason) reasons.push(amt.reason)

  const ven = scoreVendor(doc, ctx)
  score += ven.pts
  if (ven.reason) reasons.push(ven.reason)

  // Le numéro de la pièce écrit au relevé : preuve rare mais décisive.
  const num = normalizeText(doc.doc_number).replace(/ /g, '')
  if (num.length >= 5 && normalizeText(ctx.text).replace(/ /g, '').includes(num)) {
    score += 40
    reasons.push('numéro de la pièce au relevé')
  }

  // Quatre chiffres, c'est faible : on en croise partout dans un libellé. Ce
  // témoin ne peut que départager, jamais désigner à lui seul.
  const last4 = String(doc.card_last4 || '').replace(/\D/g, '')
  if (last4.length === 4 && /carte|card|visa|master/i.test(doc.payment_method || '')) {
    const words = normalizeText(ctx.text).split(' ')
    if (words.includes(last4)) {
      score += 15
      reasons.push(`carte …${last4}`)
      if (ctx.accountLast4 === last4) score += 10
    } else if (ctx.accountLast4 === last4) {
      score += 10
      reasons.push('carte du compte')
    }
  }

  const dt = scoreDates(doc, txn.txn_date)
  score += dt.pts
  if (dt.reason) reasons.push(dt.reason)

  // Déjà liée ailleurs : −40, de quoi faire retomber n'importe quelle « sûre »
  // sous la barre. Elle reste affichée (le lien précédent peut être faux) mais
  // ne sera jamais attachée d'office.
  if (doc.taken) { score -= 40; reasons.push('déjà liée à une autre ligne') }
  if (doc.status && doc.status !== 'done' && doc.type === 'receipt') { score -= 15; reasons.push('lecture non terminée') }
  if (doc.archived) { score -= 10; reasons.push('archivée') }

  return { score, reasons, nameHit: ven.hit }
}

// ── Le vivier ────────────────────────────────────────────────────────────────

function profilesByName() {
  const rows = db.prepare(`
    SELECT id, name, aliases, bank_label_patterns FROM vendor_profiles WHERE deleted_at IS NULL
  `).all()
  const byId = new Map()
  const byName = new Map()
  for (const p of rows) {
    const entry = { id: p.id, name: p.name, aliases: jsonList(p.aliases), patterns: jsonList(p.bank_label_patterns) }
    byId.set(p.id, entry)
    byName.set(normalizeText(p.name), entry)
  }
  return { byId, byName }
}

function takenKeys(excludeTxnId) {
  const rows = db.prepare(`
    SELECT matched_type || ':' || matched_id AS k FROM bank_transactions
    WHERE matched_id IS NOT NULL AND deleted_at IS NULL AND id != ?
  `).all(excludeTxnId || '')
  return new Set(rows.map(r => r.k))
}

// Pièces plausibles pour cette ligne, du bon signe : bornées par montant ET par date, sinon on
// noterait la base entière à chaque ouverture d'une ligne. La recherche libre
// (`q`) lève ces deux bornes — c'est l'humain qui cherche, on ne lui cache rien.
export function candidatePool(txn, { sources = ['receipt', 'achat'], windowDays = WINDOW_DAYS, rate = null, accountCurrency = 'CAD', q = null } = {}) {
  const amountAbs = Math.abs(Number(txn.amount) || 0)
  const orig = parseOrigAmount(txn)
  const tol = Math.max(POOL_TOL_ABS, amountAbs * POOL_TOL_PCT)
  const from = shift(txn.txn_date, -windowDays)
  const to = shift(txn.txn_date, windowDays)
  const { byId, byName } = profilesByName()
  const needle = q ? normalizeText(q) : null
  const dir = Number(txn.amount) < 0 ? -1 : 1
  const out = []

  if (sources.includes('receipt')) {
    const rows = db.prepare(`
      SELECT id, company, receipt_date, order_date, due_date, total, bank_charged_total,
             currency, receipt_number, card_last4, payment_method, status, quickbooks_id,
             archived_at, vendor_profile_id, quickbooks_type
      FROM sale_receipts
      WHERE deleted_at IS NULL
        AND ((:dir < 0 AND COALESCE(total, 0) >= 0 AND COALESCE(quickbooks_type, '') <> 'deposit')
          OR (:dir > 0 AND (total < 0 OR quickbooks_type = 'deposit')))
        AND (:any = 1 OR COALESCE(receipt_date, order_date, due_date) BETWEEN :from AND :to)
        AND (:any = 1
          OR ABS(ABS(COALESCE(bank_charged_total, total)) - :amt) <= :tol
          OR (:orig > 0 AND ABS(ABS(total) - :orig) <= 0.02)
          OR (:rate > 0 AND ABS(ABS(total) * :rate - :amt) <= :tol)
          OR (:rate > 0 AND ABS(ABS(total) * :rate * :fee - :amt) <= :tol)
          OR (:rate > 0 AND ABS(ABS(total) / :rate - :amt) <= :tol)
          OR (:rate > 0 AND ABS(ABS(total) / :rate * :fee - :amt) <= :tol))
    `).all({ any: needle ? 1 : 0, from, to, amt: amountAbs, tol, rate: rate || 0, fee: 1 + CARD_FX_FEE, orig: orig?.amount || 0, dir })
    for (const r of rows) {
      const profile = byId.get(r.vendor_profile_id) || byName.get(normalizeText(r.company))
      out.push({
        type: 'receipt', id: String(r.id), label: r.company || '(sans fournisseur)',
        company: r.company, date: r.receipt_date, order_date: r.order_date, due_date: r.due_date,
        // Un dépôt s'affiche en positif mais reste de l'argent qui ENTRE.
        total: r.quickbooks_type === 'deposit' ? -Math.abs(r.total || 0) : r.total,
        bank_charged_total: r.bank_charged_total, currency: r.currency,
        doc_number: r.receipt_number, card_last4: r.card_last4, payment_method: r.payment_method,
        status: r.status, quickbooks_id: r.quickbooks_id, archived: !!r.archived_at,
        names: [r.company, profile?.name, ...(profile?.aliases || [])].filter(Boolean),
        patterns: profile?.patterns || [],
      })
    }
  }

  if (sources.includes('achat')) {
    const rows = db.prepare(`
      SELECT id, vendor, date_achat, due_date, total_cad, currency, vendor_invoice_number,
             bill_number, payment_method, status, quickbooks_id
      FROM achats_fournisseurs
      WHERE ((:dir < 0 AND COALESCE(total_cad, 0) >= 0) OR (:dir > 0 AND total_cad < 0))
        AND (:any = 1 OR COALESCE(date_achat, due_date) BETWEEN :from AND :to)
        AND (:any = 1 OR ABS(ABS(total_cad) - :amt) <= :tol)
    `).all({ any: needle ? 1 : 0, from, to, amt: amountAbs, tol, dir })
    for (const a of rows) {
      const profile = byName.get(normalizeText(a.vendor))
      out.push({
        type: 'achat', id: String(a.id), label: a.vendor || '(sans fournisseur)',
        company: a.vendor, date: a.date_achat, order_date: null, due_date: a.due_date,
        // total_cad est déjà dans la devise du compte pour les comptes CAD ;
        // pour un compte USD la conversion repart de la devise de l'achat.
        total: a.total_cad, bank_charged_total: null,
        currency: (accountCurrency || 'CAD').toUpperCase() === 'CAD' ? 'CAD' : (a.currency || 'CAD'),
        doc_number: a.vendor_invoice_number || a.bill_number,
        card_last4: null, payment_method: a.payment_method,
        status: a.status, quickbooks_id: a.quickbooks_id, archived: false,
        names: [a.vendor, profile?.name, ...(profile?.aliases || [])].filter(Boolean),
        patterns: profile?.patterns || [],
      })
    }
  }

  if (needle) {
    return out.filter(d => normalizeText(`${d.company || ''} ${d.doc_number || ''}`).includes(needle))
  }
  return out
}

// Une ligne « en attente » est souvent la pré-autorisation d'un achat déjà
// passé à côté (même compte, ±3 jours) avec les frais de change en plus. On ne
// la touche pas : on cherche seulement ses voisines postées.
function isPending(t) {
  return t?.bank_state === 'en_attente' || Number(t?.pending) === 1
}

function postedSiblings(txn) {
  if (!isPending(txn) || !txn.account_id || !txn.txn_date) return []
  return db.prepare(`
    SELECT id, txn_date, amount, description, details, reference, orig_currency, orig_amount
    FROM bank_transactions
    WHERE account_id = ? AND id != ? AND deleted_at IS NULL AND amount * ? > 0
      AND COALESCE(pending, 0) = 0 AND COALESCE(bank_state, '') != 'en_attente'
      AND txn_date BETWEEN ? AND ?
  `).all(txn.account_id, txn.id || '', Number(txn.amount) < 0 ? -1 : 1, shift(txn.txn_date, -3), shift(txn.txn_date, 3))
}

// Une même facture existe souvent en double : lue par l'extracteur ET saisie
// en achat, ou lue deux fois. On n'en montre qu'une, sinon deux jumelles se
// bloquent l'une l'autre en « à choisir » alors que le choix est indifférent.
function sameVendor(a, b) {
  if (!a || !b) return false
  if (normalizeText(a) === normalizeText(b)) return true
  return bestNameMatch([a], b).ratio >= 0.5 || bestNameMatch([b], a).ratio >= 0.5
}

function isTwin(a, b) {
  return sameVendor(a.company, b.company)
    && Math.abs((Math.abs(a.total) || 0) - (Math.abs(b.total) || 0)) <= AMOUNT_EPS
    && Math.abs(daysBetween(a.date, b.date) ?? 99) <= 2
}

// Entre deux jumelles : jamais celle qui est déjà prise ailleurs, puis celle
// qui est publiée à QuickBooks (l'écriture existe déjà), puis le reçu, qui
// porte le PDF.
function preferred(a, b) {
  if (!!a.taken !== !!b.taken) return a.taken ? b : a
  if (!!a.quickbooks_id !== !!b.quickbooks_id) return a.quickbooks_id ? a : b
  if (a.type !== b.type) return a.type === 'receipt' ? a : b
  return a
}

function dedupe(list) {
  const out = []
  for (const c of list) {
    const twin = out.find(o => isTwin(o, c))
    if (!twin) { out.push(c); continue }
    const keep = preferred(twin, c)
    if (keep !== twin) out[out.indexOf(twin)] = keep
  }
  return out
}

// ── Abonnements : la facture du bon mois ─────────────────────────────────────
// Un abonnement mensuel dépose chaque mois la même facture, au même montant,
// chez le même fournisseur. Toutes se ressemblaient donc au point de se
// neutraliser : la bonne arrivait bien en tête, mais talonnée de quatre points
// par celle du mois précédent, aucune n'était jamais « sûre » et la ligne
// restait à traiter alors que la pièce dormait dans l'extracteur (cas CapCut,
// signalé par Charles le 2026-09-29).
//
// Quand plusieurs pièces ne se distinguent QUE par leur période, la date du
// débit tranche : celle qui colle garde sa note, les autres reculent. Une pièce
// déjà liée ailleurs ne peut pas servir de référence — sinon la facture en
// retard, seule encore libre, se ferait déclasser par celle qui est réglée.
const PERIOD_MALUS = 25
const PERIOD_SLACK_DAYS = 2

function docGap(doc, txnDate) {
  const gaps = [doc.date, doc.order_date, doc.due_date]
    .map(d => daysBetween(d, txnDate))
    .filter(g => g != null)
    .map(Math.abs)
  return gaps.length ? Math.min(...gaps) : null
}

export function demoteOtherPeriods(scored, txnDate) {
  const groups = []
  for (const c of scored) {
    const g = groups.find(grp => sameVendor(grp[0].company, c.company)
      && Math.abs(Math.abs(grp[0].total || 0) - Math.abs(c.total || 0)) <= AMOUNT_EPS)
    if (g) g.push(c); else groups.push([c])
  }
  for (const group of groups) {
    if (group.length < 2) continue
    const gaps = new Map(group.map(c => [c, docGap(c, txnDate)]))
    const reference = group
      .filter(c => !c.taken && gaps.get(c) != null)
      .reduce((best, c) => (best == null || gaps.get(c) < gaps.get(best) ? c : best), null)
    if (!reference) continue
    const bestGap = gaps.get(reference)
    for (const c of group) {
      const gap = gaps.get(c)
      if (c === reference || gap == null || gap <= bestGap + PERIOD_SLACK_DAYS) continue
      c.score -= PERIOD_MALUS
      c.reasons.push('une autre facture du même fournisseur colle mieux à la date')
    }
  }
  return scored
}

// Candidates triées, chacune avec sa note, ses raisons et son verdict.
export function findDocCandidates(txn, account, { q = null, limit = 6, sources = ['receipt', 'achat'], windowDays = WINDOW_DAYS, excludeTxnId = null } = {}) {
  if (!txn || !Number(txn.amount)) return { candidates: [], ambiguous: false }
  const accountCurrency = (account?.currency || 'CAD').toUpperCase()
  const rateFor = usdCadRateLookup()
  const rate = rateFor(txn.txn_date) || null
  const text = bankText(txn)
  const accountLast4 = (String(account?.account_number || '').match(/(\d{4})(?!.*\d)/) || [])[1] || null
  const taken = takenKeys(excludeTxnId || txn.id)
  const ctx = { rate, text, accountCurrency, accountLast4, orig: parseOrigAmount(txn) }
  const siblings = postedSiblings(txn).map(s => ({
    txn: s, ctx: { rate: rateFor(s.txn_date) || null, text: bankText(s), accountCurrency, accountLast4, orig: parseOrigAmount(s) },
  }))

  const pool = candidatePool(txn, { sources, windowDays, rate, accountCurrency, q })
    .filter(doc => signCompatible(txn.amount, doc.total))
  const scored = pool.map((doc) => {
    const d = { ...doc, taken: taken.has(`${doc.type}:${doc.id}`) }
    const r = scoreDoc(txn, d, ctx)
    // Pré-autorisation : la même pièce vise aussi la ligne postée voisine —
    // c'est elle qui la porte. Montrée ici, jamais attribuée d'office.
    if (siblings.some(s => scoreVendor(d, s.ctx).hit && scoreAmount(Math.abs(s.txn.amount), d, s.ctx).pts >= 26)) {
      r.score -= 35
      r.reasons.push('pré-autorisation : la ligne postée la porte')
    }
    return { ...d, score: r.score, reasons: r.reasons, nameHit: r.nameHit }
  })

  demoteOtherPeriods(scored, txn.txn_date)

  // À note égale (même fournisseur, même montant : le cas des abonnements), la
  // plus ancienne d'abord — c'est celle qui reste à régler.
  scored.sort((a, b) => b.score - a.score
    || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.id).localeCompare(String(b.id)))

  const kept = dedupe(q ? scored : scored.filter(c => c.score >= 40)).slice(0, limit)
  if (!kept.length) return { candidates: [], ambiguous: false }

  const lead = kept.length > 1 ? kept[0].score - kept[1].score : 999
  kept.forEach((c, i) => {
    c.verdict = i === 0 && c.score >= 85 && lead >= 25 ? 'sure'
      : c.score >= 55 ? 'probable' : 'faible'
  })
  return { candidates: kept, ambiguous: kept.length > 1 && lead < 25 }
}

// Une note devient une confiance ≥ 0,8 — la barre de l'appariement automatique —
// seulement si la pièce est sûre, que le fournisseur est reconnu au relevé et
// qu'elle n'est pas déjà prise. C'est exactement l'invariant d'avant (0,5 + 0,4
// sans reconnaissance du fournisseur = jamais 0,8) : on augmente le nombre de
// propositions, pas le nombre de décisions prises sans l'humain.
export function confidenceFromScore(c) {
  const raw = Math.min(0.99, Math.max(0.05, (c.score || 0) / 130))
  const eligible = c.verdict === 'sure' && c.nameHit && !c.taken
  // « Sûre » veut dire franchissable : la note sert à ordonner, pas à recaler
  // au dernier centième une pièce que le barème a déjà déclarée certaine.
  return Math.round((eligible ? Math.max(0.8, raw) : Math.min(raw, 0.79)) * 100) / 100
}
