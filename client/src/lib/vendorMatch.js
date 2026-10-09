// Rapprochement d'un nom de fournisseur extrait d'un reçu avec la liste des vendors
// QuickBooks existants. But : présélectionner le bon fournisseur AVANT de proposer
// d'en créer un nouveau, pour ne pas accumuler des doublons (« Amazon.com.ca ULC »
// vs un vendor QB déjà nommé « Amazon »). Logique pure, testée à part.

// Suffixes juridiques / mots vides ignorés au rapprochement. On ne retire PAS les
// mots porteurs de sens (web, services…) pour éviter qu'« Amazon Web Services » (AWS)
// ne s'aligne par erreur sur « Amazon » (commerce de détail).
export const VENDOR_STOPWORDS = new Set([
  'inc', 'ulc', 'ltd', 'ltee', 'llc', 'corp', 'corporation', 'co', 'company', 'cie',
  'enr', 'srl', 'sarl', 'sa', 'the', 'les', 'la', 'le',
])

export function normalizeVendor(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')    // retire les accents
    .replace(/[^a-z0-9]+/g, ' ')                          // ponctuation → espace
    .replace(/\s+/g, ' ')
    .trim()
}

export function vendorTokens(name) {
  return normalizeVendor(name).split(' ').filter(t => t && !VENDOR_STOPWORDS.has(t))
}

// Meilleur vendor QB pour le nom extrait. Conservateur : match exact normalisé,
// sinon containment de chaîne complète (≥ 4 car.), sinon recouvrement de tokens
// (Jaccard) ≥ 0,6. Retourne null si rien d'assez proche — mieux vaut proposer
// « nouveau » que rattacher au mauvais fournisseur.
export function findBestVendorMatch(company, vendors) {
  const target = normalizeVendor(company)
  if (!target || !vendors?.length) return null

  const exact = vendors.find(v => normalizeVendor(v.DisplayName) === target)
  if (exact) return exact

  const targetTokens = vendorTokens(company)
  if (targetTokens.length === 0) return null
  const targetSet = new Set(targetTokens)

  let best = null, bestScore = 0, bestJaccard = 0
  for (const v of vendors) {
    const vNorm = normalizeVendor(v.DisplayName)
    const vt = vendorTokens(v.DisplayName)
    if (vt.length === 0) continue
    const inter = vt.filter(t => targetSet.has(t)).length
    if (inter === 0) continue
    const union = new Set([...targetTokens, ...vt]).size
    const jaccard = inter / union
    // Containment plein (« amazon » ⊂ « amazon com ca ») avec ≥ 4 car. : signal fort.
    const shorter = vNorm.length <= target.length ? vNorm : target
    const longer = vNorm.length <= target.length ? target : vNorm
    const contained = shorter.length >= 4 && longer.includes(shorter)
    // Marque courte (« DHL », « UPS », « GLS ») suivie d'un qualificatif : « DHL
    // (Douanes) » doit retrouver le vendor « DHL ». Trop court pour le containment de
    // chaîne (« ups » ⊂ « groups »), on l'accepte en MOTS ENTIERS : tous les mots du
    // nom court figurent tels quels dans le nom long.
    const [fewT, manyT] = vt.length <= targetTokens.length ? [vt, targetTokens] : [targetTokens, vt]
    const tokenContained = fewT.every(t => t.length >= 2 && manyT.includes(t))
    const score = Math.max(jaccard, contained || tokenContained ? 0.8 : 0)
    // À score égal, le nom le plus proche en mots l'emporte (« DHL » avant « DHL Express »).
    if (score > bestScore || (score === bestScore && jaccard > bestJaccard)) { bestScore = score; bestJaccard = jaccard; best = v }
  }
  return bestScore >= 0.6 ? best : null
}
