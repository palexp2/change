// Le modèle d'une proposition du rapprochement bancaire — PUR, sans base.
//
// Une proposition est ce qu'un moteur a trouvé et qu'un humain doit trancher :
// « cette ligne du relevé, c'est l'écriture QuickBooks #4182 ». Les moteurs
// écrivaient l'état comptable tout seuls ; ils produisent désormais ceci, et
// c'est le clic qui écrit.
//
// Deux invariants portent tout le reste (voir schema.js, bloc bank_proposals) :
//   • l'empreinte ne contient NI la confiance NI l'écart — sinon un refus
//     serait contourné au passage suivant par un 0,82 devenu 0,84 ;
//   • une proposition refusée n'est jamais re-proposée, jamais supprimée.
import crypto from 'node:crypto'

export const KINDS = [
  'qb_link', 'doc_match', 'vendor_expense', 'invoice_found',
  'payment_clear', 'paie_debit', 'aga_repartition', 'debt_payment',
]

// Ordre d'examen : la preuve la plus forte d'abord. Une ligne réclamée par un
// producteur n'est plus offerte aux suivants (voir dedupeClaims).
export const KIND_ORDER = [
  'qb_link', 'doc_match', 'invoice_found',
  'paie_debit', 'debt_payment', 'aga_repartition',
  'payment_clear', 'vendor_expense',
]

export function proposalFingerprint(p) {
  const parts = [p.kind, p.bank_txn_id, p.target_type || '', p.target_id || '', p.period_key || '']
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
}

// Ce qui, dans une proposition, mérite une mise à jour quand elle est reproduite
// à l'identique de cible mais pas de contenu (la banque a livré un écart, la
// preuve s'est précisée).
const MUTABLE = ['amount', 'currency', 'confidence', 'evidence', 'payload', 'account_id']

function sameContent(a, b) {
  return MUTABLE.every((k) => JSON.stringify(a?.[k] ?? null) === JSON.stringify(b?.[k] ?? null))
}

/**
 * Confronte ce qui existe en base à ce que le passage vient de produire.
 *
 * @param {Array} existantes  lignes bank_proposals (au moins fingerprint, status, run_count)
 * @param {Array} produites   propositions candidates (sans id ni statut)
 * @param {{staleRuns?: number, runId?: string}} opts
 * @returns {{inserer:[], mettreAJour:[], inchangees:[], perimer:[], ignorees:{refusees:number, acceptees:number}}}
 */
export function reconcilePropositions(existantes, produites, { staleRuns = 6, runId = null } = {}) {
  const byFp = new Map()
  // Les propositions VIVANTES par (ligne, nature) : la base n'en tolère qu'une
  // (index partiel). Une deuxième candidate sur la même ligne attend donc que
  // la première soit tranchée — sinon l'insertion échouerait et ferait tomber
  // tout le passage.
  const vivantes = new Map()
  for (const e of existantes || []) {
    byFp.set(e.fingerprint, e)
    if (e.status === 'proposee' || e.status === 'acceptee') vivantes.set(`${e.bank_txn_id}|${e.kind}`, e)
  }

  const inserer = []
  const mettreAJour = []
  const inchangees = []
  const ignorees = { refusees: 0, acceptees: 0 }
  const vues = new Set()

  for (const raw of produites || []) {
    const p = { ...raw, fingerprint: raw.fingerprint || proposalFingerprint(raw), run_id: runId }
    vues.add(p.fingerprint)
    const old = byFp.get(p.fingerprint)
    if (!old) {
      const rival = vivantes.get(`${p.bank_txn_id}|${p.kind}`)
      if (rival) { ignorees.enAttente = (ignorees.enAttente || 0) + 1; continue }
      vivantes.set(`${p.bank_txn_id}|${p.kind}`, p)
      inserer.push(p)
      continue
    }
    // Le « non » de l'humain est définitif, et le « oui » est déjà appliqué.
    if (old.status === 'refusee') { ignorees.refusees++; continue }
    if (old.status === 'acceptee') { ignorees.acceptees++; continue }
    // Une proposition périmée que le moteur retrouve redevient vivante : la
    // péremption dit « plus personne ne la produit », pas « elle est fausse ».
    // Sans ça, l'unicité de l'empreinte l'empêcherait de revenir pour toujours.
    if (old.status === 'perimee') { mettreAJour.push({ ...p, id: old.id, revive: true }); continue }
    if (sameContent(old, p)) inchangees.push({ ...p, id: old.id })
    else mettreAJour.push({ ...p, id: old.id })
  }

  // Une proposition que plus aucun passage ne reproduit a perdu sa raison
  // d'être (la ligne a été appariée autrement, l'écriture a été supprimée).
  const perimer = []
  for (const e of existantes || []) {
    if (e.status !== 'proposee' || vues.has(e.fingerprint)) continue
    if ((e.runs_unseen ?? 0) + 1 >= staleRuns) perimer.push(e.id)
  }

  return { inserer, mettreAJour, inchangees, perimer, ignorees }
}

// Une ligne de relevé n'est réclamée qu'une fois par passage : le producteur le
// plus fort gagne, les autres se taisent. Sans ça, la même transaction
// arriverait à l'écran avec trois propositions contradictoires.
export function dedupeClaims(propositions) {
  const rank = new Map(KIND_ORDER.map((k, i) => [k, i]))
  const best = new Map()
  for (const p of propositions || []) {
    const r = rank.has(p.kind) ? rank.get(p.kind) : 99
    const prev = best.get(p.bank_txn_id)
    if (!prev || r < prev.rank || (r === prev.rank && (p.confidence || 0) > (prev.p.confidence || 0))) {
      best.set(p.bank_txn_id, { rank: r, p })
    }
  }
  return [...best.values()].map((v) => v.p)
}

// Machine à états : une proposition ne se décide qu'une fois.
export function nextStatus(current, action) {
  if (current !== 'proposee') return null
  if (action === 'accepter') return 'acceptee'
  if (action === 'refuser') return 'refusee'
  return null
}

// Preuve lisible. Les moteurs parlent en codes (`exact`, `tolerance`) ; l'écran
// doit dire pourquoi, en français, sans jargon.
export function evidenceFor(kind, facts = {}) {
  const out = []
  const push = (label, detail) => { if (label) out.push(detail ? { label, detail } : { label }) }
  if (facts.method) push(METHOD_LABEL[facts.method] || facts.method)
  if (facts.delta === 0) push('Même montant qu’au relevé')
  else if (facts.delta != null) push('Écart de montant', `${facts.delta.toFixed(2)} $`)
  if (facts.gap === 0) push('Même date')
  else if (facts.gap != null) push('Date décalée', `${facts.gap} jour${facts.gap > 1 ? 's' : ''}`)
  if (facts.account) push('Porté à un autre compte', facts.account)
  if (facts.rate) push('Taux de change vérifié', String(facts.rate))
  if (facts.vendor) push('Fournisseur reconnu', facts.vendor)
  if (facts.count != null) push('Habitude', `${facts.count} fois`)
  return out
}

const METHOD_LABEL = {
  exact: 'Montant et date exacts',
  fenetre: 'Même montant, date décalée',
  devise: 'Montant en devise du compte',
  tolerance: 'Montant proche (frais ou conversion)',
  conversion: 'Conversion de devise',
  autre_compte: 'Écriture portée à un autre compte',
  agregat: 'Plusieurs écritures QuickBooks',
  agregat_inverse: 'Plusieurs lignes pour une écriture',
}
