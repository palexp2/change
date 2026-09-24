// Producteur « lien QuickBooks » : ce que la recherche approfondie a trouvé et
// qui n'est PAS assez sûr pour être posé sans un humain.
//
// Avant, tout était posé d'office : une ligne appariée « par tolérance » (un
// montant proche, à quelques jours) recevait son lien QuickBooks comme une
// ligne au montant et à la date exacts. Les deux ne se valent pas. La liste
// blanche dit lesquelles restent automatiques ; le reste devient une
// proposition, avec sa preuve.
import { evidenceFor, proposalFingerprint } from './model.js'

// Méthodes de bankQbSearch.js. `exact` = même montant, même date à 4 jours près.
// `conversion` n'entre ici que VÉRIFIÉE (taux relu sur le Transfer QuickBooks).
export const DEFAULT_AUTO_METHODS = ['exact', 'conversion']

// Liens dont un humain répond : ni la sync ni une proposition ne les touchent.
const HUMAN_METHODS = new Set(['manuel', 'proposition', 'erp'])

export function parseAutoMethods(raw) {
  if (raw == null) return DEFAULT_AUTO_METHODS
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

function isAuto(match, autoMethods) {
  if (!autoMethods.includes(match.method)) return false
  // Une conversion non vérifiée garde un écart : elle ne se pose jamais seule.
  if (match.method === 'conversion' && !match.verified) return false
  // Idem si un jour « devise_taux » entre dans la liste : le taux doit avoir été
  // relu. Décision de Charles (19 sept. 2026) : ces liens restent à confirmer.
  if (match.method === 'devise_taux' && !match.verified) return false
  return true
}

/**
 * Sépare le résultat de `searchAccount` en deux : ce qu'on pose, ce qu'on propose.
 *
 * @param {Map} matches  sortie de searchAccount (+ verifyConversions)
 * @param {{autoMethods?: string[], account?: object, txnById?: Map}} opts
 * @returns {{auto: Map, proposals: Array}}
 */
export function pickQbProposals(matches, { autoMethods = DEFAULT_AUTO_METHODS, account = null, txnById = null } = {}) {
  const auto = new Map()
  const proposals = []
  for (const [txnId, m] of matches) {
    // Les lignes du fichier pas encore importées n'existent pas en base : ni
    // lien, ni proposition (elles n'ont pas d'id stable).
    if (String(txnId).startsWith('à-importer-')) continue
    if (isAuto(m, autoMethods)) { auto.set(txnId, m); continue }
    const e = m.entries?.[0]
    if (!e?.qbId) continue
    const txn = txnById?.get(txnId)
    // Rien à proposer quand le lien est déjà là : soit c'est la même écriture
    // (la question est réglée), soit un humain l'a posé ou confirmé et une
    // proposition viendrait l'écraser à son insu.
    if (txn?.qb_txn_id) {
      if (String(txn.qb_txn_id) === String(e.qbId)) continue
      if (HUMAN_METHODS.has(txn.qb_match_method)) continue
    }
    const p = {
      kind: 'qb_link',
      bank_txn_id: txnId,
      account_id: account?.id || null,
      target_type: 'qb_entity',
      target_id: String(e.qbId),
      amount: txn?.amount ?? null,
      currency: account?.currency || null,
      confidence: confidenceOf(m),
      evidence: evidenceFor('qb_link', {
        method: m.method,
        delta: m.delta ?? null,
        gap: m.gap ?? null,
        account: m.method === 'autre_compte' ? e.accountName : null,
        rate: m.rate || null,
      }),
      payload: {
        qb_txn_type: e.entity || null,
        qb_txn_id: String(e.qbId),
        method: m.method,
        delta: m.delta ?? null,
        account_name: e.accountName || null,
        rate: m.rate || null,
        label: e.label || null,
        date: e.date || null,
      },
      producer: 'bankQbSearch',
    }
    p.fingerprint = proposalFingerprint(p)
    proposals.push(p)
  }
  return { auto, proposals }
}

// Une confiance lisible pour l'écran : la méthode donne le socle, l'écart de
// date et de montant l'abaissent. Ce n'est pas une probabilité, c'est un ordre
// de tri honnête.
const BASE = {
  exact: 0.98, conversion: 0.95, devise: 0.9, fenetre: 0.85,
  autre_compte: 0.75, agregat: 0.7, agregat_inverse: 0.7, tolerance: 0.65,
}
export function confidenceOf(m) {
  let c = BASE[m.method] ?? 0.6
  if (m.gap) c -= Math.min(0.15, m.gap * 0.01)
  if (m.delta) c -= 0.05
  return Math.max(0.3, Math.round(c * 100) / 100)
}
