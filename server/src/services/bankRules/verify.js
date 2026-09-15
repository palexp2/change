/**
 * Le garde-fou des règles : avant qu'une règle serve, on la confronte au passé.
 *
 * Une règle se trompe de deux façons, et aucune ne se voit à l'écriture :
 *
 *  • elle ATTRAPE TROP — le motif est si court qu'il ramasse d'autres
 *    fournisseurs. « ups » attrape « GROUPE UPS » mais aussi « STARTUPS INC ».
 *  • elle POSE LA MAUVAISE VALEUR — le compte de dépense qu'elle propose n'est
 *    pas celui qu'on a réellement utilisé sur les lignes qu'elle couvre.
 *
 * Le passé répond aux deux : pour chaque ligne déjà comptabilisée que la règle
 * attraperait, on regarde ce qui a VRAIMENT été fait. Une règle qui contredit
 * ne serait-ce qu'une ligne n'est pas proposée d'office — elle est montrée avec
 * son désaccord, et c'est l'humain qui tranche.
 */
import db from '../../db/database.js'
import { ruleSpecificity, ruleLabelOf, labelMatches, parseConditions } from './match.js'
import { normalizeLabel } from '../bankReconciliation.js'
import { resolveVendorFromBankLabel, stripBankNoise } from '../scrapers/vendorFromBankLabel.js'

// Des mots trop courants pour désigner un fournisseur à eux seuls : un motif
// qui se réduit à ça attraperait la moitié du relevé.
const TOO_COMMON = new Set([
  'inc', 'ltd', 'ltee', 'ltée', 'corp', 'co', 'sa', 'enr', 'sec', 'senc',
  'paiement', 'payment', 'facture', 'invoice', 'achat', 'purchase', 'depot',
  'virement', 'transfer', 'transaction', 'frais', 'fee', 'fees', 'canada',
  'quebec', 'montreal', 'service', 'services', 'compte', 'account', 'the',
  // Le vocabulaire des relevés : présent partout, distinctif nulle part.
  'credit', 'debit', 'group', 'groupe', 'insurance', 'assurance', 'payable',
  'deposit', 'depot', 'loan', 'pret', 'marge', 'solde', 'balance', 'com',
  'business', 'entreprise', 'entreprises', 'pmts', 'pad', 'acc', 'misc',
])

// Un motif est-il assez distinctif ? On refuse le trop court et le trop banal.
export function patternStrength(pattern) {
  const tokens = normalizeLabel(pattern).split(' ').filter(Boolean)
  if (!tokens.length) return { ok: false, reason: 'motif vide' }
  const useful = tokens.filter((t) => t.length >= 3 && !TOO_COMMON.has(t))
  if (!useful.length) return { ok: false, reason: 'motif trop courant pour désigner un fournisseur' }
  const letters = useful.join('').length
  if (letters < 5) return { ok: false, reason: 'motif trop court — il attraperait n\'importe quoi' }
  return { ok: true, tokens: useful }
}

// Ce qui a réellement été fait sur une ligne déjà comptabilisée : le
// fournisseur, le compte de dépense et le code de taxe de son document.
function bookedFacts(txn) {
  if (txn.matched_type === 'achat' && txn.matched_id) {
    const a = db.prepare('SELECT vendor, expense_account_id, tax_code_id, lines FROM achats_fournisseurs WHERE id=?').get(txn.matched_id)
    if (!a) return null
    let account = a.expense_account_id
    if (!account) {
      try { account = JSON.parse(a.lines || '[]')[0]?.account_id || null } catch { account = null }
    }
    return { vendor: (a.vendor || '').trim() || null, expense_account_id: account, tax_code_id: a.tax_code_id || null }
  }
  if (txn.matched_type === 'receipt' && txn.matched_id) {
    const r = db.prepare('SELECT company FROM sale_receipts WHERE id=?').get(txn.matched_id)
    return r ? { vendor: (r.company || '').trim() || null, expense_account_id: null, tax_code_id: null } : null
  }
  // La plupart des lignes du relevé ne pointent pas vers un document de l'ERP :
  // elles sont liées à une écriture QuickBooks. Le fournisseur reconnu au
  // libellé reste alors un témoin — assez pour dire qu'une règle se trompe de
  // fournisseur, pas assez pour juger un compte de dépense.
  const hit = resolveVendorFromBankLabel(ruleLabelOf(txn))
  if (hit?.profile?.name) {
    return { vendor: hit.profile.name, expense_account_id: null, tax_code_id: null, weak: true }
  }
  return null
}

/**
 * Confronte une règle aux 24 derniers mois du relevé.
 *
 * @returns {{
 *   ok, strength, covers, a_traiter, checked,
 *   agree, disagree, conflicts, other_vendors, warnings, sample
 * }}
 *   `checked` = lignes déjà comptabilisées que la règle attraperait ;
 *   `disagree` = celles où elle poserait autre chose que ce qui a été fait.
 */
export function verifyRule(rule, { months = 24, sample = 5 } = {}) {
  const warnings = []

  // 1) Le motif est-il assez distinctif ? (Une règle à conditions détaillées a
  //    déjà été écrite à la main dans QuickBooks : on ne juge que le motif simple.)
  const detailed = parseConditions(rule.conditions)
  const strength = detailed ? { ok: true } : patternStrength(rule.label_pattern || '')
  if (!strength.ok) warnings.push(strength.reason)

  const rows = db.prepare(`
    SELECT id, account_id, txn_date, description, details, amount, status, matched_type, matched_id
    FROM bank_transactions
    WHERE deleted_at IS NULL AND txn_date >= date('now', ?)
    ORDER BY txn_date DESC
  `).all(`-${months} months`)

  const hits = rows.filter((r) => ruleSpecificity(rule, r) > 0)

  let agree = 0
  const conflicts = []
  const vendors = new Map()

  for (const t of hits) {
    const facts = bookedFacts(t)
    if (!facts) continue
    if (facts.vendor) vendors.set(facts.vendor.toLowerCase(), facts.vendor)

    const problems = []
    if (rule.vendor_name && facts.vendor
      && normalizeLabel(rule.vendor_name) !== normalizeLabel(facts.vendor)) {
      problems.push(`comptabilisée au nom de ${facts.vendor}`)
    }
    if (rule.expense_account_id && facts.expense_account_id
      && String(rule.expense_account_id) !== String(facts.expense_account_id)) {
      problems.push('portée à un autre compte de dépense')
    }
    if (rule.tax_code_id && facts.tax_code_id
      && String(rule.tax_code_id) !== String(facts.tax_code_id)) {
      problems.push('avec un autre code de taxe')
    }

    if (problems.length) {
      if (conflicts.length < sample) {
        conflicts.push({ txn_date: t.txn_date, label: ruleLabelOf(t), amount: t.amount, why: problems.join(', ') })
      }
    } else agree++
  }

  const facts = hits.map((t) => bookedFacts(t))
  const checked = facts.filter(Boolean).length
  // Confirmé par un document de l'ERP, pas seulement par le libellé reconnu.
  const checked_strong = facts.filter((f) => f && !f.weak).length
  const disagree = hits.filter((t) => {
    const f = bookedFacts(t)
    if (!f) return false
    return (rule.vendor_name && f.vendor && normalizeLabel(rule.vendor_name) !== normalizeLabel(f.vendor))
      || (rule.expense_account_id && f.expense_account_id && String(rule.expense_account_id) !== String(f.expense_account_id))
      || (rule.tax_code_id && f.tax_code_id && String(rule.tax_code_id) !== String(f.tax_code_id))
  }).length

  // 2) Le motif ramasse-t-il plusieurs fournisseurs différents ? C'est le signe
  //    d'un motif trop large, même quand les comptes concordent.
  const otherVendors = [...vendors.values()]
  if (rule.vendor_name) {
    const others = otherVendors.filter((v) => normalizeLabel(v) !== normalizeLabel(rule.vendor_name))
    if (others.length) warnings.push(`attrape aussi ${others.slice(0, 3).join(', ')}`)
  } else if (otherVendors.length > 1) {
    warnings.push(`attrape ${otherVendors.length} fournisseurs différents`)
  }

  // 3) Combien de libellés DIFFÉRENTS la règle ramasse-t-elle ? Une règle qui
  //    vise un fournisseur n'en voit qu'un ou deux ; au-delà, elle déborde —
  //    c'est ainsi qu'une règle sur « COMPTE DIVERS » attrape aussi la Ville de
  //    Québec au passage.
  const labels = new Map()
  for (const t of hits) {
    const key = stripBankNoise(ruleLabelOf(t)) || ruleLabelOf(t)
    labels.set(key, (labels.get(key) || 0) + 1)
  }
  const distinct = [...labels.entries()].sort((a, b) => b[1] - a[1])
  if (distinct.length > 3) {
    warnings.push(`attrape ${distinct.length} libellés différents : ${distinct.slice(0, 4).map(([l]) => l).join(', ')}…`)
  }

  if (disagree) warnings.push(`${disagree} ligne${disagree > 1 ? 's' : ''} déjà comptabilisée${disagree > 1 ? 's' : ''} autrement`)
  if (!checked && hits.length) warnings.push('aucune ligne passée pour la vérifier')

  return {
    // Une règle est « sûre » quand elle est distinctive, qu'elle ne contredit
    // rien, qu'elle ne déborde pas sur d'autres libellés, et qu'au moins une
    // ligne passée l'a confirmée.
    ok: strength.ok && disagree === 0 && checked > 0 && distinct.length <= 3,
    strength_ok: strength.ok,
    covers: hits.length,
    a_traiter: hits.filter((t) => t.status === 'a_traiter' && !t.matched_id).length,
    checked,
    checked_strong,
    distinct_labels: distinct.slice(0, 6).map(([label, n]) => ({ label, n })),
    agree,
    disagree,
    conflicts,
    other_vendors: otherVendors.slice(0, 5),
    warnings,
    sample: hits.slice(0, sample).map((t) => ({
      id: t.id, txn_date: t.txn_date, label: ruleLabelOf(t), amount: t.amount, status: t.status,
    })),
  }
}

// Une autre règle vivante couvre-t-elle déjà ces lignes ? Deux règles qui se
// marchent dessus, c'est la porte ouverte aux écritures incohérentes.
export function overlappingRules(rule, rules) {
  const p = rule.label_pattern
  if (!p) return []
  return (rules || [])
    .filter((r) => r.id !== rule.id && r.label_pattern)
    .filter((r) => labelMatches(r.label_pattern, p) || labelMatches(p, r.label_pattern))
    .map((r) => ({ id: r.id, name: r.name }))
}


/**
 * Une règle qui n'attrape rien, et ce qu'il faudrait assouplir.
 *
 * Les règles venues de QuickBooks ont été écrites contre le libellé que SON
 * flux bancaire reçoit, pas contre celui de notre relevé : « COM. INSURANCE AGA
 * ASS. COLL. » là où nous lisons « AGA ASS. COLL. », « BUSINESS PAD SAGE
 * MENTORAT » là où nous lisons « SAGE MENTORAT ». Le fond de la règle est bon,
 * c'est son préfixe qui ne nous parvient pas.
 *
 * On cherche donc le PLUS LONG bout de chaque libellé qui, lui, se retrouve au
 * relevé — en retirant des mots par la gauche, jamais au milieu — et on le
 * soumet au même garde-fou que les autres. Rien n'est appliqué : c'est une
 * proposition.
 *
 * @returns { terms, pattern, check } ou null si rien ne peut la sauver.
 */
export function suggestRelaxation(rule, { months = 24 } = {}) {
  const c = parseConditions(rule.conditions)
  if (!c) return null
  const labelTerms = c.terms.filter((t) => t.field === 'label')
  if (!labelTerms.length) return null

  const rows = db.prepare(`
    SELECT id, account_id, txn_date, description, details, amount, status, matched_type, matched_id
    FROM bank_transactions
    WHERE deleted_at IS NULL AND txn_date >= date('now', ?)
  `).all(`-${months} months`)

  // Le plus long suffixe de mots qui se retrouve quelque part au relevé.
  const relaxOne = (value) => {
    const tokens = String(value).split(/\s+/).filter(Boolean)
    for (let start = 0; start < tokens.length; start++) {
      const candidate = tokens.slice(start).join(' ')
      const strength = patternStrength(candidate)
      if (!strength.ok) continue
      // Un seul mot ne suffit à désigner un fournisseur que s'il est long et
      // rare : « GROUP » ou « credit » ramasseraient la moitié du relevé.
      if (strength.tokens.length === 1 && strength.tokens[0].length < 8) continue
      if (rows.some((r) => labelMatches(ruleLabelOf(r), candidate))) return candidate
    }
    return null
  }

  const terms = []
  let changed = false
  for (const t of c.terms) {
    if (t.field !== 'label') { terms.push(t); continue }
    const relaxed = relaxOne(t.value)
    if (!relaxed) {
      // En mode ET, un libellé introuvable condamne la règle entière.
      if (c.mode !== 'any') return null
      continue
    }
    if (relaxed !== t.value) changed = true
    terms.push({ ...t, value: relaxed })
  }
  if (!changed || !terms.some((t) => t.field === 'label')) return null

  const candidate = { ...rule, conditions: JSON.stringify({ mode: c.mode, terms }) }
  const check = verifyRule(candidate, { months })
  if (!check.covers) return null
  return {
    terms,
    conditions: candidate.conditions,
    pattern: summarizeTerms(c.mode, terms),
    check,
  }
}

function summarizeTerms(mode, terms) {
  const join = mode === 'any' ? ' ou ' : ' et '
  return terms.map((t) => (t.field === 'amount'
    ? `${t.op === 'lt' ? 'moins de' : t.op === 'gt' ? 'plus de' : 'égal à'} ${t.value}`
    : `« ${t.value} »`)).join(join)
}
