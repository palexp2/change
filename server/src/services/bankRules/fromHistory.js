/**
 * Des règles proposées à partir de ce qu'on a RÉELLEMENT publié.
 *
 * Sans attendre le fichier exporté de QuickBooks, l'ERP sait déjà dire « huit
 * achats Novo Express, tous sur le même compte et le même code de taxe » : c'est
 * une règle toute faite, à confirmer d'un clic. On ne propose que les
 * fournisseurs dont l'usage est CONSTANT — une habitude qui se contredit n'est
 * pas une règle, c'est une décision à prendre ligne par ligne.
 */
import db from '../../db/database.js'
import { vendorHistory } from '../bankEntryDraft.js'
import { stripBankNoise } from '../scrapers/vendorFromBankLabel.js'
import { activeRules } from './store.js'
import { verifyRule, patternStrength, overlappingRules } from './verify.js'

const MIN_PURCHASES = 3
// Un fournisseur facturé trois fois la même semaine n'est pas une habitude :
// on exige que ça se répète dans le temps, et que ce soit encore d'actualité.
const MIN_DISTINCT_MONTHS = 2
const MAX_DORMANT_MONTHS = 12

/**
 * @returns liste de règles candidates, les mieux étayées d'abord.
 */
export function suggestRulesFromHistory({ limit = 20 } = {}) {
  // Les fournisseurs qui reviennent : au moins trois achats publiés.
  const vendors = db.prepare(`
    SELECT vendor, COUNT(*) AS n,
           COUNT(DISTINCT substr(date_achat, 1, 7)) AS months,
           MAX(date_achat) AS last_date
    FROM achats_fournisseurs
    WHERE vendor IS NOT NULL AND TRIM(vendor) <> '' AND quickbooks_id IS NOT NULL
      AND date_achat >= date('now', '-24 months')
    GROUP BY LOWER(TRIM(vendor))
    HAVING n >= ? AND months >= ? AND last_date >= date('now', ?)
    ORDER BY n DESC
  `).all(MIN_PURCHASES, MIN_DISTINCT_MONTHS, `-${MAX_DORMANT_MONTHS} months`)

  const rules = activeRules()
  // Les motifs déjà déclarés sur les fiches fournisseurs : la règle proposée
  // reprend le plus court (le plus tolérant), sinon le nom du fournisseur.
  const patternsOf = (name) => {
    const row = db.prepare('SELECT bank_label_patterns FROM vendor_profiles WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND deleted_at IS NULL').get(name)
    try {
      const list = JSON.parse(row?.bank_label_patterns || '[]')
      return list.filter(Boolean).sort((a, b) => a.length - b.length)
    } catch { return [] }
  }

  const out = []
  for (const { vendor, n, months, last_date: lastDate } of vendors) {
    const h = vendorHistory(vendor, { limit: 40 })
    if (!h || !h.consistent) continue
    const expense = h.expense_accounts[0]?.value || null
    if (!expense) continue

    // Déjà couvert par une règle vivante ? On ne repropose pas.
    if (rules.some((r) => r.vendor_name && r.vendor_name.toLowerCase() === vendor.toLowerCase())) continue

    // Le motif : le plus court déclaré sur la fiche, sinon le nom nettoyé. On
    // refuse tout de suite ce qui attraperait n'importe quoi.
    const pattern = patternsOf(vendor)[0] || stripBankNoise(vendor) || vendor
    if (!patternStrength(pattern).ok) continue

    const candidate = {
      name: vendor,
      label_pattern: pattern,
      direction: 'sortie',
      priority: 100,
      vendor_name: vendor,
      expense_account_id: expense,
      tax_code_id: h.tax_codes[0]?.value || null,
      qb_type: ['purchase', 'bill', 'cc_credit'].includes(h.types?.[0]?.value) ? h.types[0].value : null,
      memo: h.memos[0]?.value || null,
      origin: 'historique',
    }

    // Le garde-fou : la règle est confrontée à ce qui a RÉELLEMENT été fait sur
    // les lignes qu'elle attraperait. Une seule contradiction suffit à la
    // sortir des propositions sûres.
    const check = verifyRule(candidate)
    if (!check.covers) continue

    const overlaps = overlappingRules(candidate, rules)
    const warnings = [...check.warnings, ...(overlaps.length ? [`recoupe la règle « ${overlaps[0].name} »`] : [])]

    out.push({
      ...candidate,
      evidence: `${n} achats publiés sur ${months} mois, toujours au même compte${candidate.tax_code_id ? ' et au même code de taxe' : ''}`,
      last_date: lastDate,
      covers: check.covers,
      covers_a_traiter: check.a_traiter,
      // Vérifiée = confirmée par le passé sans aucune contradiction.
      verified: check.ok && !overlaps.length,
      checked: check.checked,
      disagree: check.disagree,
      conflicts: check.conflicts,
      warnings,
      sample: check.sample.map((t) => ({ txn_date: t.txn_date, label: t.label, amount: t.amount })),
    })
    if (out.length >= limit) break
  }
  // Les sûres d'abord, puis celles qui rendent le plus de service.
  return out.sort((a, b) => (b.verified - a.verified)
    || (b.covers_a_traiter - a.covers_a_traiter)
    || (b.covers - a.covers))
}
