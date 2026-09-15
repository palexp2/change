/**
 * Les habitudes que le RELEVÉ raconte, et les règles qu'elles valent.
 *
 * « Déduire » partait des achats déjà publiés : ça ne voyait que les
 * fournisseurs ayant une facture dans l'ERP. Le relevé, lui, porte tout — les
 * frais de banque, les virements, les abonnements payés à la carte. On y
 * cherche donc directement ce qui REVIENT : un même libellé, plusieurs fois,
 * sur plusieurs mois, dans le même sens.
 *
 * Trois degrés de préparation, et on ne fait jamais semblant d'avoir le
 * troisième :
 *   • complète  — le fournisseur est reconnu ET toutes les fois passées ont été
 *                 portées au même compte de dépense ;
 *   • à compléter — le fournisseur est reconnu, le compte reste à choisir ;
 *   • à qualifier — le libellé revient, mais personne ne sait de qui il s'agit.
 *
 * Le garde-fou des règles s'applique avant tout le reste : un libellé qui se
 * réduit à « pmts entreprises » ou « virement interac » n'est pas une habitude,
 * c'est l'emballage de la banque.
 */
import db from '../../db/database.js'
import { ruleLabelOf, ruleSpecificity } from './match.js'
import { activeRules } from './store.js'
import { patternStrength, verifyRule } from './verify.js'
import { stripBankNoise, resolveVendorFromBankLabel } from '../scrapers/vendorFromBankLabel.js'

const MIN_LINES = 3
const MIN_MONTHS = 2

// Le compte de dépense auquel une ligne a réellement été portée, quand l'ERP
// le sait (achat lié). Les anciens achats le rangent dans leur première ligne.
function bookedAccount(txn) {
  if (txn.matched_type !== 'achat' || !txn.matched_id) return null
  const a = db.prepare('SELECT expense_account_id, tax_code_id, lines FROM achats_fournisseurs WHERE id=?').get(txn.matched_id)
  if (!a) return null
  if (a.expense_account_id) return { account: a.expense_account_id, tax: a.tax_code_id || null }
  try {
    const first = JSON.parse(a.lines || '[]')[0]
    return first?.account_id ? { account: first.account_id, tax: a.tax_code_id || null } : null
  } catch { return null }
}

/**
 * @param months  profondeur de relevé examinée
 * @returns habitudes triées : les plus prêtes d'abord, puis les plus fréquentes
 */
export function habitsFromStatement({ months = 18, limit = 120 } = {}) {
  const rules = activeRules()
  const txns = db.prepare(`
    SELECT id, account_id, txn_date, description, details, amount, status, matched_type, matched_id
    FROM bank_transactions
    WHERE deleted_at IS NULL AND txn_date >= date('now', ?)
  `).all(`-${months} months`)

  // On ne propose que ce qu'aucune règle ne couvre déjà.
  const groups = new Map()
  for (const t of txns) {
    if (rules.some((r) => ruleSpecificity(r, t) > 0)) continue
    const key = stripBankNoise(ruleLabelOf(t))
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const out = []
  for (const [pattern, lines] of groups) {
    if (lines.length < MIN_LINES) continue
    const strength = patternStrength(pattern)
    if (!strength.ok) continue

    const months_ = new Set(lines.map((t) => t.txn_date.slice(0, 7)))
    if (months_.size < MIN_MONTHS) continue

    // Un libellé qui part dans les deux sens ne décrit pas une habitude.
    const out_ = lines.every((t) => t.amount < 0)
    const in_ = lines.every((t) => t.amount > 0)
    if (!out_ && !in_) continue

    const vendors = new Set()
    const accounts = new Set()
    const taxes = new Set()
    for (const t of lines) {
      const hit = resolveVendorFromBankLabel(ruleLabelOf(t))
      if (hit?.profile?.name) vendors.add(hit.profile.name)
      const booked = bookedAccount(t)
      if (booked) { accounts.add(booked.account); if (booked.tax) taxes.add(booked.tax) }
    }

    const vendor = vendors.size === 1 ? [...vendors][0] : null
    const account = vendor && accounts.size === 1 ? [...accounts][0] : null
    const tax = account && taxes.size === 1 ? [...taxes][0] : null

    const candidate = {
      name: vendor || pattern,
      label_pattern: pattern,
      direction: out_ ? 'sortie' : 'entree',
      priority: 100,
      vendor_name: vendor,
      expense_account_id: account,
      tax_code_id: tax,
      origin: 'releve',
    }
    // Le même garde-fou que partout : une habitude qui contredit le passé ou
    // qui ramasse plusieurs fournisseurs n'est pas offerte comme sûre.
    const check = verifyRule(candidate)

    out.push({
      ...candidate,
      // « complète » | « a_completer » | « a_qualifier »
      tier: account ? 'complete' : (vendor ? 'a_completer' : 'a_qualifier'),
      lines: lines.length,
      months: months_.size,
      vendors_seen: [...vendors].slice(0, 3),
      amount_min: null,
      amount_max: null,
      span: [
        Math.min(...lines.map((t) => Math.abs(t.amount))),
        Math.max(...lines.map((t) => Math.abs(t.amount))),
      ],
      warnings: check.warnings,
      verified: check.ok,
      sample: lines
        .sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1))
        .slice(0, 3)
        .map((t) => ({ txn_date: t.txn_date, label: ruleLabelOf(t), amount: t.amount })),
    })
  }

  const rank = (h) => ({ complete: 0, a_completer: 1, a_qualifier: 2 })[h.tier]
  return out.sort((a, b) => rank(a) - rank(b) || b.lines - a.lines).slice(0, limit)
}
