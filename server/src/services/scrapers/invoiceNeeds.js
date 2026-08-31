import { v4 as uuid } from 'uuid'
import db from '../../db/database.js'
import { resolveVendorFromBankLabel } from './vendorFromBankLabel.js'
import { nowIso } from '../../utils/datetime.js'

// « Quelles transactions bancaires attendent leur facture ? »
//
// C'est la liste de travail de la collecte ciblée : plutôt que d'aspirer tout
// ce qu'un portail expose, on part des sorties d'argent non comptabilisées et
// on ne descend que les factures qui portent ces montants-là.
//
// « Non comptabilisée » est la définition de deriveStatus() (bankReconciliation.js) :
// statut a_traiter ou facture_recue, c'est-à-dire ni écriture QuickBooks retrouvée,
// ni document publié, ni ligne peinte en vert/jaune par Michel dans TRX_Orisha.

// Concordance de montant : exact au cent, sinon un écart relatif toléré pour
// absorber la conversion de devise et les frais bancaires — mais seulement s'il
// n'y a qu'un seul candidat dans cette marge (sinon on ne devine pas).
export const EXACT_TOLERANCE = 0.011
export const RELATIVE_TOLERANCE = 0.02
// Le débit suit la facture, rarement l'inverse.
export const DAYS_BEFORE = 10
export const DAYS_AFTER = 3
// Une facture peut être publiée quelques jours après le débit : on réessaie,
// en espaçant, puis on abandonne pour ne pas repartir en boucle chaque nuit.
export const RETRY_DELAYS_DAYS = [1, 3, 7]

const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000)

/**
 * Le document `doc` peut-il être la facture du besoin `need` ?
 * @returns {{ok:true, exact:boolean, delta:number}|{ok:false, reason:string}}
 */
export function amountMatches(need, doc) {
  if (doc.amount == null) return { ok: false, reason: 'montant inconnu' }
  // Devises différentes : le montant débité n'est pas celui facturé. C'est le
  // terrain de bank_charged_total (ligne « Frais de conversion »), qui reste
  // une décision humaine — on ne l'apparie jamais tout seul.
  if (doc.currency && need.currency && doc.currency !== need.currency) {
    return { ok: false, reason: 'devise différente' }
  }
  const target = Math.abs(need.amount)
  const value = Math.abs(doc.amount)
  const delta = Math.abs(target - value)
  if (delta < EXACT_TOLERANCE) return { ok: true, exact: true, delta }
  if (target > 0 && delta / target <= RELATIVE_TOLERANCE) return { ok: true, exact: false, delta }
  return { ok: false, reason: 'montant hors tolérance' }
}

export function dateMatches(need, doc) {
  if (!doc.date || !need.txn_date) return true // sans date, seul le montant tranche
  const diff = dayDiff(need.txn_date, doc.date)
  return diff >= -DAYS_AFTER && diff <= DAYS_BEFORE
}

/**
 * Apparie une liste de besoins à une liste de documents listés par un collecteur.
 * Un document ne sert qu'une fois. Les concordances exactes sont attribuées en
 * premier : sans cela, un besoin à ±2 % pourrait rafler le document qu'un autre
 * besoin réclamait au cent près.
 *
 * @returns {{picks: Array, unmatched: Array}}
 */
export function selectDocuments(needs, docs) {
  const taken = new Set()
  const picks = []
  const unmatched = []
  const pending = []

  for (const need of needs) {
    const eligible = docs.filter(d => dateMatches(need, d)).map(d => ({ d, m: amountMatches(need, d) }))
    const exact = eligible.filter(x => x.m.ok && x.m.exact)
    if (exact.length === 1) {
      picks.push({ need, doc: exact[0].d, exact: true, delta: exact[0].m.delta })
      taken.add(exact[0].d.externalId)
      continue
    }
    if (exact.length > 1) {
      unmatched.push({ need, reason: 'ambigue', note: `${exact.length} factures au même montant` })
      continue
    }
    pending.push({ need, eligible })
  }

  // Deuxième passe : tolérance relative, sur ce qu'il reste.
  for (const { need, eligible } of pending) {
    const near = eligible.filter(x => x.m.ok && !taken.has(x.d.externalId))
    if (near.length === 1) {
      picks.push({ need, doc: near[0].d, exact: false, delta: near[0].m.delta })
      taken.add(near[0].d.externalId)
    } else if (near.length > 1) {
      unmatched.push({ need, reason: 'ambigue', note: `${near.length} factures dans la marge de 2 %` })
    } else {
      unmatched.push({ need, reason: 'introuvable', note: `aucune facture à ${Math.abs(need.amount).toFixed(2)} ${need.currency || ''}`.trim() })
    }
  }
  return { picks, unmatched }
}

// Transactions non comptabilisées, sortie d'argent, sans document lié.
function openTransactions(sinceDate) {
  return db.prepare(`
    SELECT t.id, t.txn_date, t.amount, t.account_id,
           COALESCE(NULLIF(t.details, ''), t.description) AS label,
           a.currency
    FROM bank_transactions t
    JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL
      AND t.amount < 0
      AND t.matched_id IS NULL
      AND t.status IN ('a_traiter', 'facture_recue')
      AND t.txn_date >= ?
    ORDER BY t.txn_date DESC
  `).all(sinceDate)
}

/**
 * Recalcule la table invoice_needs à partir du relevé. Idempotent : une ligne
 * par transaction (index unique), les compteurs de tentatives sont préservés.
 */
export function refreshInvoiceNeeds({ lookbackDays = 120 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10)
  const collectors = db.prepare(`
    SELECT id, vendor_profile_id FROM scraper_accounts
    WHERE deleted_at IS NULL AND enabled = 1 AND vendor_profile_id IS NOT NULL
  `).all()
  const byProfile = new Map(collectors.map(c => [c.vendor_profile_id, c.id]))

  const upsert = db.prepare(`
    INSERT INTO invoice_needs (id, bank_txn_id, scraper_account_id, vendor_profile_id, amount, currency, txn_date, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bank_txn_id) DO UPDATE SET
      scraper_account_id = excluded.scraper_account_id,
      vendor_profile_id  = excluded.vendor_profile_id,
      amount   = excluded.amount,
      currency = excluded.currency,
      txn_date = excluded.txn_date,
      status   = CASE WHEN invoice_needs.status = 'trouvee' THEN 'trouvee' ELSE excluded.status END,
      updated_at = excluded.updated_at
  `)

  let withCollector = 0
  let without = 0
  const run = db.transaction((rows) => {
    for (const t of rows) {
      const hit = resolveVendorFromBankLabel(t.label)
      if (!hit) continue // fournisseur inconnu : rien à proposer, on ne crée pas de bruit
      const accountId = byProfile.get(hit.profile.id) || null
      upsert.run(uuid(), t.id, accountId, hit.profile.id, t.amount, t.currency, t.txn_date,
        accountId ? 'en_attente' : 'sans_collecteur', nowIso())
      if (accountId) withCollector++
      else without++
    }
  })
  run(openTransactions(since))

  // Les transactions appariées depuis (à la main, ou par une autre tournée)
  // sortent de la file.
  db.prepare(`
    UPDATE invoice_needs SET status = 'trouvee', updated_at = ?
    WHERE status != 'trouvee'
      AND bank_txn_id IN (SELECT id FROM bank_transactions WHERE matched_id IS NOT NULL)
  `).run(nowIso())

  return { withCollector, without }
}

// Un besoin est-il à retenter ? Les délais s'allongent, puis on s'arrête.
export function isDue(need, at = Date.now()) {
  if (need.status === 'trouvee' || need.status === 'sans_collecteur') return false
  if (!need.last_attempt_at) return true
  const attempts = need.attempts || 0
  if (attempts >= RETRY_DELAYS_DAYS.length) return false
  const wait = RETRY_DELAYS_DAYS[Math.max(0, attempts - 1)] * 86400_000
  return at - new Date(need.last_attempt_at).getTime() >= wait
}

/** Besoins actifs d'un compte de collecte, prêts à être retentés. */
export function dueNeedsForAccount(accountId) {
  const rows = db.prepare(`
    SELECT n.*, t.description AS bank_description
    FROM invoice_needs n
    JOIN bank_transactions t ON t.id = n.bank_txn_id
    WHERE n.scraper_account_id = ?
      AND n.status IN ('en_attente', 'introuvable', 'ambigue')
      AND t.matched_id IS NULL AND t.deleted_at IS NULL
    ORDER BY n.txn_date DESC
  `).all(accountId)
  return rows.filter(n => isDue(n))
}

export function markNeed(needId, fields) {
  const keys = Object.keys(fields)
  db.prepare(`UPDATE invoice_needs SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
    .run(...keys.map(k => fields[k]), nowIso(), needId)
}

export function bumpAttempt(needId) {
  db.prepare('UPDATE invoice_needs SET attempts = COALESCE(attempts,0) + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), needId)
}
