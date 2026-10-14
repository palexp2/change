// Type de taxe d'un document que rien d'autre ne sait classer (fournisseur jamais
// vu, extraction restée muette) : l'IA choisit TOUJOURS un type d'après la nature
// de l'achat, puis le choix est validé contre les taxes du document. Le résultat
// devient le signal « document » de fiscalDetection.js — une présélection, que
// l'utilisateur confirme à la publication.
import db from '../db/database.js'
import { TRANSACTION_TYPES, getTransactionType } from './fiscalStatus.js'
import { resolveFiscalDetection, taxSignature, typeMatchesAmounts } from './fiscalDetection.js'
import { ask } from './bankAiGuess.js'

const CATALOG = TRANSACTION_TYPES
  .filter(t => t.side !== 'vente')
  .map(t => `- "${t.key}" : ${t.label}. ${t.note}`)
  .join('\n')

export function buildPrompt(r) {
  let items = r.items
  if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = [] } }
  const lines = (Array.isArray(items) ? items : []).slice(0, 15)
    .map(i => `- ${String(i?.description || '').slice(0, 160)} : ${i?.total ?? ''}`).join('\n')
  return `Tu classes un document d'achat d'Orisha (entreprise québécoise inscrite à la TPS/TVQ) selon son traitement TPS/TVQ.
Fournisseur : ${r.company || '?'}
Adresse : ${r.address || '?'}
Description : ${r.general_description || '?'}
Devise : ${r.currency || 'CAD'}
Sous-total : ${r.subtotal ?? 0} · TPS : ${r.tps ?? 0} · TVQ : ${r.tvq ?? 0} · Autres taxes : ${r.other_taxes ?? 0} · Total : ${r.total ?? 0}
Lignes :
${lines || '(aucune)'}

Types possibles :
${CATALOG}

Choisis TOUJOURS le type le plus probable d'après la nature de l'achat et l'émetteur, cohérent avec les taxes facturées (Taxable ⇒ TPS/TVQ facturées ; Détaxé/Exonéré/Hors champ ⇒ 0 $ de taxe). Un petit fournisseur québécois qui ne facture aucune taxe reste un achat local : choisis le type le plus proche cohérent avec 0 $ de taxe.
Réponds en JSON : {"transaction_type": "<clé>"}`
}

export function parseGuess(text, sig) {
  let j
  try { j = JSON.parse(String(text || '').replace(/^```(json)?|```$/g, '').trim()) } catch { return null }
  const key = j?.transaction_type
  const t = getTransactionType(key)
  if (!t || t.side === 'vente') return null
  if (typeMatchesAmounts(key, sig) === false) return null
  return key
}

const attempted = new Set()

// Ne fait rien si le document a déjà un type, une détection, ou est publié.
// Retourne la clé posée (l'appelant diffuse la fiche à jour), sinon null.
export async function guessMissingTransactionType(id, { askImpl = ask } = {}) {
  if (!id || attempted.has(id)) return null
  attempted.add(id)
  const r = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(id)
  if (!r || r.status !== 'done' || r.quickbooks_id || r.archived_at || r.transaction_type
    || r.quickbooks_type === 'deposit') return null
  const profile = r.vendor_profile_id
    ? db.prepare('SELECT * FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(r.vendor_profile_id)
    : null
  if (resolveFiscalDetection(r, { profile }).transaction_type) return null
  const sig = taxSignature(r)
  let key = null
  try {
    const prompt = buildPrompt(r)
    const first = await askImpl(prompt)
    key = parseGuess(first, sig)
    // Choix contredit par les taxes du document : une seconde chance, en le disant.
    if (!key) {
      key = parseGuess(await askImpl(`${prompt}

Ta première réponse (${String(first || '').slice(0, 120)}) contredit les taxes du document (${sig.label}). Choisis un autre type, cohérent avec ces taxes.`), sig)
    }
  } catch (e) {
    console.warn(`fiscalAiGuess ${id}: ${e.message}`)
  }
  if (!key) return null
  db.prepare(`UPDATE sale_receipts SET extracted_transaction_type=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?`).run(key, id)
  return key
}
