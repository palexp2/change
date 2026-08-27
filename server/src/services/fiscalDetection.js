import db from '../db/database.js'
import { getTransactionType, suggestTransactionType, FISCAL_STATUS } from './fiscalStatus.js'

// Résolveur de détection fiscale d'un reçu/facture : détermine le TYPE DE TRANSACTION
// et le CODE DE TAXE QB probables en croisant PLUSIEURS signaux, chacun VALIDÉ contre
// les montants de taxe réellement extraits du document. Remplace la suggestion
// mono-heuristique (suggestTransactionType seul) : un défaut de profil appris sur une
// facture détaxée ne doit pas se propager à une facture du même fournisseur qui, elle,
// facture la TPS — et inversement (bug café / Simplex : mauvais code 0 % silencieux).
//
// Signaux, du plus fiable au moins fiable :
//   1. profil     — défaut appris/édité du profil fournisseur (default_transaction_type)
//   2. historique — vote majoritaire des publications QB passées du même fournisseur
//                   (même devise d'abord — un fournisseur bi-devise peut avoir deux régimes)
//   3. document   — classification IA faite à l'extraction (extracted_transaction_type)
//   4. regles     — heuristiques nom/description/montants (fiscalStatus.suggestTransactionType)
//
// Le premier signal COMPATIBLE avec la signature de taxes du document gagne. Les signaux
// plus prioritaires écartés pour incompatibilité deviennent des `conflicts` affichés à
// l'opérateur — la détection n'est jamais silencieusement contradictoire.

// Signature de montants attendue par chaque NOM de code de taxe QB (mêmes noms que
// fiscalStatus.js). Un code absent d'ici (code custom, TVH…) = pas d'opinion (null).
const CODE_SIGNATURES = {
  'TPS/TVQ QC - 9,975': { tps: true, tvq: true },
  'TPS/TVQ repas':      { tps: true, tvq: true },
  'TPS':                { tps: true, tvq: false },
  'TVQ QC - 9,975':     { tps: false, tvq: true },
  'Détaxé':             { tps: false, tvq: false },
  'Exonéré':            { tps: false, tvq: false },
  'Hors champ':         { tps: false, tvq: false },
}

const fmtAmt = n => (Math.round(Number(n) * 100) / 100).toFixed(2).replace('.', ',')

// Signature de taxes du document : quelles taxes sont réellement facturées, et les
// montants collent-ils aux taux légaux (TPS 5 %, TVQ 9,975 %) ? Tolérance ±20 % du
// taux : les factures à lignes mixtes (partie détaxée) ou taxes-incluses dévient bien
// au-delà — c'est précisément ce qu'on veut signaler sans crier au moindre arrondi.
export function taxSignature({ subtotal, tps, tvq, other_taxes } = {}) {
  const sub = Number(subtotal) || 0
  const tpsAmt = Number(tps) || 0
  const tvqAmt = Number(tvq) || 0
  const otherAmt = Number(other_taxes) || 0
  const hasTps = tpsAmt > 0
  const hasTvq = tvqAmt > 0
  const hasOther = otherAmt > 0
  const near = (amt, target) => (sub > 0 ? Math.abs(amt / sub - target) <= target * 0.2 : null)
  const kind = hasTps && hasTvq ? 'tps_tvq' : hasTps ? 'tps' : hasTvq ? 'tvq' : hasOther ? 'autre' : 'aucune'
  const parts = []
  if (hasTps) parts.push(`${fmtAmt(tpsAmt)} $ de TPS`)
  if (hasTvq) parts.push(`${fmtAmt(tvqAmt)} $ de TVQ`)
  if (hasOther) parts.push(`${fmtAmt(otherAmt)} $ d'autres taxes`)
  const label = parts.length
    ? `le document facture ${parts.join(' et ')}`
    : 'le document ne facture aucune taxe'
  return {
    hasTps, hasTvq, hasOther, kind, label,
    tpsRateOk: hasTps ? near(tpsAmt, 0.05) : null,
    tvqRateOk: hasTvq ? near(tvqAmt, 0.09975) : null,
  }
}

// Un code de taxe est-il compatible avec les montants du document ?
// true / false / null (code inconnu du référentiel → pas d'opinion).
export function codeMatchesAmounts(codeName, sig) {
  const expected = CODE_SIGNATURES[codeName]
  if (!expected || !sig) return null
  if (expected.tps !== sig.hasTps || expected.tvq !== sig.hasTvq) return false
  // Codes 0 % : des taxes « autres » (TVH/PST) facturées contredisent aussi le 0 %.
  if (!expected.tps && !expected.tvq && sig.hasOther) return false
  return true
}

// Un type de transaction peut-il expliquer les montants du document ? Il suffit qu'UN
// de ses codes acceptés colle (ex. « Achat local taxable » couvre TPS+TVQ, TPS seule
// ou TVQ seule). false seulement si TOUS ses codes contredisent les montants.
export function typeMatchesAmounts(typeKey, sig) {
  const type = getTransactionType(typeKey)
  if (!type) return null
  const verdicts = type.codes.map(c => codeMatchesAmounts(c, sig))
  if (verdicts.some(v => v === true)) return true
  if (verdicts.length && verdicts.every(v => v === false)) return false
  return null
}

// Code recommandé pour un type, ADAPTÉ aux montants : parmi les codes acceptés du
// type, le premier qui colle à la signature (« Achat local taxable » + TPS seule →
// « TPS », pas « TPS/TVQ QC - 9,975 »). À défaut, le code recommandé générique.
export function recommendedCodeForType(typeKey, sig) {
  const type = getTransactionType(typeKey)
  if (!type) return null
  if (!sig) return type.codes[0]
  return type.codes.find(c => codeMatchesAmounts(c, sig) === true) || type.codes[0]
}

// Vote majoritaire des publications QB passées du même fournisseur (par profil si
// rattaché, sinon par nom exact). La devise du reçu est privilégiée : un fournisseur
// bi-devise peut relever de deux régimes (import USD hors-champ vs achat CAD taxable).
// Retourne { type, count, total, lastSeen } ou null si aucun historique.
export function vendorHistoryVote({ id, vendor_profile_id, company, currency } = {}) {
  const conds = [
    'deleted_at IS NULL', 'quickbooks_id IS NOT NULL',
    "transaction_type IS NOT NULL AND TRIM(transaction_type) != ''",
  ]
  const params = []
  if (id) { conds.push('id != ?'); params.push(id) }
  if (vendor_profile_id) { conds.push('vendor_profile_id = ?'); params.push(vendor_profile_id) }
  else if (company && String(company).trim()) { conds.push('company = ? COLLATE NOCASE'); params.push(String(company).trim()) }
  else return null
  const rows = db.prepare(`
    SELECT transaction_type, currency, COUNT(*) n, MAX(COALESCE(receipt_date, created_at)) last_seen
    FROM sale_receipts WHERE ${conds.join(' AND ')}
    GROUP BY transaction_type, currency
  `).all(...params)
  if (!rows.length) return null
  const cur = String(currency || 'CAD').toUpperCase()
  const sameCur = rows.filter(r => String(r.currency || 'CAD').toUpperCase() === cur)
  const pool = sameCur.length ? sameCur : rows
  const byType = new Map()
  for (const r of pool) {
    const e = byType.get(r.transaction_type) || { type: r.transaction_type, count: 0, lastSeen: '' }
    e.count += r.n
    if (r.last_seen && r.last_seen > e.lastSeen) e.lastSeen = r.last_seen
    byType.set(r.transaction_type, e)
  }
  const ranked = [...byType.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1))
  return { ...ranked[0], total: ranked.reduce((s, r) => s + r.count, 0) }
}

const SOURCE_SENTENCES = {
  profil:     t => `Le profil fournisseur suggère « ${t} »`,
  historique: (t, c) => `L'historique du fournisseur (${c.count} publication${c.count > 1 ? 's' : ''}) suggère « ${t} »`,
  document:   t => `L'analyse IA du document suggère « ${t} »`,
  regles:     t => `Les règles internes suggèrent « ${t} »`,
}

const SOURCE_LABELS = {
  profil: 'profil fournisseur',
  historique: c => `historique du fournisseur (${c.count} publication${c.count > 1 ? 's' : ''})`,
  document: 'analyse IA du document',
  regles: 'règles internes',
}

// Résolution complète. `receipt` : ligne sale_receipts (items déjà parsés ou JSON).
// `profile` : profil fournisseur résolu par l'appelant (évite un second lookup).
// `history` : vote injectable pour les tests — undefined = calculé ici, null = aucun.
export function resolveFiscalDetection(receipt = {}, { profile = null, history = undefined } = {}) {
  const sig = taxSignature(receipt)
  let items = receipt.items
  if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = [] } }

  let vote = history
  if (vote === undefined) {
    try { vote = vendorHistoryVote(receipt) } catch { vote = null }
  }

  const candidates = []
  if (profile?.default_transaction_type) {
    candidates.push({ type: profile.default_transaction_type, source: 'profil' })
  }
  if (vote?.type) candidates.push({ type: vote.type, source: 'historique', count: vote.count })
  if (receipt.extracted_transaction_type) {
    candidates.push({ type: receipt.extracted_transaction_type, source: 'document' })
  }
  try {
    const heuristic = suggestTransactionType({
      company: receipt.company, currency: receipt.currency,
      tps: receipt.tps, tvq: receipt.tvq,
      generalDescription: receipt.general_description, items,
    })
    if (heuristic) candidates.push({ type: heuristic, source: 'regles' })
  } catch { /* heuristique best effort */ }

  const valid = candidates.filter(c => getTransactionType(c.type))
  const conflicts = []
  let winner = null
  for (const c of valid) {
    if (typeMatchesAmounts(c.type, sig) === false) {
      const label = getTransactionType(c.type).label
      conflicts.push({
        source: c.source,
        transaction_type: c.type,
        message: `${SOURCE_SENTENCES[c.source](label, c)}, mais ${sig.label}.`,
      })
      continue
    }
    winner = c
    break
  }

  const agreements = winner
    ? [...new Set(valid.filter(c => c.type === winner.type).map(c => c.source))]
    : []

  let confidence = null
  if (winner) {
    if (agreements.length >= 2) confidence = 'haute'
    else if (winner.source === 'profil' || (winner.source === 'historique' && winner.count >= 3)) confidence = 'haute'
    else if (winner.source === 'regles') confidence = 'basse'
    else confidence = 'moyenne'
    // Un signal plus prioritaire contredit les montants → la confiance en prend un coup.
    if (conflicts.length) confidence = confidence === 'haute' ? 'moyenne' : 'basse'
  }

  // Alerte de taux : une TPS/TVQ facturée qui ne colle pas au taux légal trahit une
  // extraction bancale (taxes incluses, ligne mixte) — à vérifier avant publication.
  const warnings = []
  if (sig.tpsRateOk === false) warnings.push(`Le montant de TPS extrait (${fmtAmt(receipt.tps)} $) ne correspond pas à 5 % du sous-total — vérifier les montants ou utiliser des codes par ligne.`)
  if (sig.tvqRateOk === false) warnings.push(`Le montant de TVQ extrait (${fmtAmt(receipt.tvq)} $) ne correspond pas à 9,975 % du sous-total — vérifier les montants ou utiliser des codes par ligne.`)

  const type = winner ? getTransactionType(winner.type) : null
  return {
    transaction_type: winner?.type || null,
    type_label: type?.label || null,
    status: type?.status || null,
    status_label: type ? (FISCAL_STATUS[type.status]?.label || type.status) : null,
    tax_code_name: winner ? recommendedCodeForType(winner.type, sig) : null,
    expected_codes: type?.codes || [],
    source: winner?.source || null,
    source_label: winner
      ? (winner.source === 'historique' ? SOURCE_LABELS.historique(winner) : SOURCE_LABELS[winner.source])
      : null,
    confidence,
    agreements,
    conflicts,
    warnings,
    signature: {
      has_tps: sig.hasTps, has_tvq: sig.hasTvq, has_other: sig.hasOther,
      kind: sig.kind, label: sig.label, tps_rate_ok: sig.tpsRateOk, tvq_rate_ok: sig.tvqRateOk,
    },
    // Verdict montants ↔ chaque code de taxe connu (nom → true/false). Sert au front à
    // écarter un code pré-rempli (défaut du profil fournisseur) que les montants du
    // document contredisent : le livre Amazon (TPS seule, TVH ON remise) arrivait
    // pré-rempli « TPS/TVQ QC - 9,975 » par le profil, et QB refusait la publication.
    code_amount_verdicts: Object.fromEntries(
      Object.keys(CODE_SIGNATURES).map(name => [name, codeMatchesAmounts(name, sig)]),
    ),
  }
}
