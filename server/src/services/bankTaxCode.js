/**
 * Le code de taxe EXACT d'une écriture bancaire (demande de Charles, 2026-10-03 :
 * « à la place d'écrire Taxe : Aucune, mets le code exact qui sera mis dans QBO »).
 *
 * Les achats publiés n'ont presque jamais porté de code (QuickBooks posait alors
 * « NON », hors taxes) : l'habitude « aucune » ne dit rien. Quand rien d'autre ne
 * donne de code, le statut fiscal du fournisseur tranche (profil, historique,
 * règles — resolveFiscalDetection), validé contre « aucune taxe facturée » : il ne
 * peut donc proposer qu'un code à taux zéro (Hors champ, Exonéré, Détaxé).
 */
import db from '../db/database.js'
import { resolveFiscalDetection } from './fiscalDetection.js'
import { resolveTaxCodeIdsByName } from './quickbooks.js'

// Les codes à taux zéro : publiés tels quels, ils ne changent pas le montant.
export const ZERO_RATE_CODES = new Set(['Hors champ', 'Exonéré', 'Détaxé'])

let cache = { at: 0, map: null }
async function idOf(name) {
  if (!cache.map || Date.now() - cache.at > 10 * 60 * 1000) {
    cache = { at: Date.now(), map: await resolveTaxCodeIdsByName([...ZERO_RATE_CODES]) }
  }
  return cache.map.get(name) || null
}

/** { id, name, source, confidence } ou null. Ne lève jamais. */
export async function zeroRateTaxCodeFor({ vendor, currency, profileId = null, amount = 0 }) {
  if (!vendor) return null
  try {
    const profile = profileId
      ? db.prepare('SELECT * FROM vendor_profiles WHERE id = ?').get(profileId)
      : db.prepare('SELECT * FROM vendor_profiles WHERE name = ? AND deleted_at IS NULL').get(vendor)
    const r = resolveFiscalDetection(
      { company: vendor, currency: currency || 'CAD', tps: 0, tvq: 0, subtotal: Math.abs(amount) || 1, total: Math.abs(amount) || 1, vendor_profile_id: profile?.id },
      { profile },
    )
    const name = r?.tax_code_name
    if (!name || !ZERO_RATE_CODES.has(name)) return null
    const id = await idOf(name)
    return id ? { id: String(id), name, source: r.source, confidence: r.confidence } : null
  } catch { return null }
}
