import db from '../../db/database.js'
import { normalizeLabel } from '../bankReconciliation.js'

// Reconnaître un fournisseur DANS un libellé de relevé bancaire.
//
// L'ERP savait déjà faire l'inverse — « ce libellé contient-il le nom du
// fournisseur de ce document candidat ? » (labelMatchesVendor). Partir de la
// ligne bancaire pour savoir quel portail interroger demandait le sens
// manquant. C'est le maillon qui rend la collecte pilotable par le relevé.
//
// Principe : aucune correspondance floue. Un profil précis, ou rien. Se tromper
// de fournisseur ici ferait télécharger — et comptabiliser — la facture d'un
// tiers. En cas d'égalité entre deux profils, on refuse plutôt que de deviner.

// Bruit ajouté par les terminaux de paiement et les relevés, retiré avant
// comparaison. Tout ce qui reste après « — » vient de la sync du fichier TRX
// (elle y accole le montant d'origine), pas du fournisseur.
const TRX_SUFFIX = /\s+[—–-]\s+-?[\d\s.,]+$/
// Code de terminal accolé au nom : « AMZN MKTP CA*5A2507RG0 », « SQ *LE CAFE ».
const TERMINAL_CODE = /\*[a-z0-9]{4,}/gi
// Queue géographique : ville + province/état + pays. On ne retire que la fin de
// chaîne — « CANADA COMPUTERS » ne doit pas perdre son premier mot.
const GEO_TAIL = /\b([a-z]{2}\s+)?(can|usa|us|ca)(\s+[a-z]{2})?\s*$/i
// Jeton alphanumérique mêlant lettres et chiffres : identifiant de transaction,
// jamais un nom de fournisseur.
const ALNUM_NOISE = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}\b/gi

export function stripBankNoise(raw) {
  let s = String(raw || '').replace(TRX_SUFFIX, '')
  s = s.replace(TERMINAL_CODE, ' ')
  s = normalizeLabel(s)
  s = s.replace(ALNUM_NOISE, ' ')
  // La queue géographique se retire par couches : « toronto on can on ».
  for (let i = 0; i < 3; i++) s = s.replace(GEO_TAIL, ' ').trim()
  return s.replace(/\s+/g, ' ').trim()
}

// Cache court plutôt qu'invalidation explicite : les motifs s'éditent depuis la
// fiche fournisseur, et une résolution qui ignorerait une saisie faite il y a
// deux minutes serait incompréhensible. 30 s suffisent à éviter de relire la
// table à chaque ligne d'un balayage de relevé.
const CACHE_TTL_MS = 30_000
let cache = null
let cachedAt = 0
export function invalidateBankLabelCache() { cache = null }

function profiles() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache
  cachedAt = Date.now()
  cache = db.prepare(`
    SELECT id, name, aliases, bank_label_patterns
    FROM vendor_profiles WHERE deleted_at IS NULL
  `).all().map(row => {
    const parse = (v) => { try { return JSON.parse(v || '[]') } catch { return [] } }
    return {
      id: row.id,
      name: row.name,
      aliases: parse(row.aliases),
      patterns: parse(row.bank_label_patterns),
    }
  })
  return cache
}

// Longueur du nom reconnu dans le libellé, ou 0. Sert de poids : « Amazon Web
// Services » (17) l'emporte sur « Amazon » (6) dans « AMAZON WEB SERVICES … ».
// Sans ce départage, une facture AWS serait attribuée à Amazon.ca.
function matchWeight(label, name) {
  const tokens = normalizeLabel(name).split(' ').filter(t => t.length >= 3)
  if (!tokens.length) return 0
  const compact = tokens.join('')
  if (tokens.every(t => label.includes(t))) return compact.length
  if (compact.length >= 5 && label.replace(/ /g, '').includes(compact)) return compact.length
  return 0
}

/**
 * @param {string} rawLabel libellé du relevé (details en priorité, sinon description)
 * @returns {{profile:{id,name}, via:'motif'|'alias'|'nom', weight:number}|null}
 */
export function resolveVendorFromBankLabel(rawLabel) {
  const label = stripBankNoise(rawLabel)
  if (!label) return null

  let best = null
  let tie = false
  for (const p of profiles()) {
    let weight = 0
    let via = null
    // Les motifs sont la déclaration explicite de l'utilisateur : à poids égal
    // avec un nom deviné, ils l'emportent (d'où le > strict plus bas).
    for (const pattern of p.patterns) {
      const w = matchWeight(label, pattern)
      if (w > weight) { weight = w; via = 'motif' }
    }
    for (const alias of p.aliases) {
      const w = matchWeight(label, alias)
      if (w > weight) { weight = w; via = 'alias' }
    }
    const w = matchWeight(label, p.name)
    if (w > weight) { weight = w; via = 'nom' }
    if (!weight) continue

    if (!best || weight > best.weight) { best = { profile: { id: p.id, name: p.name }, via, weight }; tie = false }
    else if (weight === best.weight && p.id !== best.profile.id) tie = true
  }
  // Deux fournisseurs revendiquent le libellé avec la même force : on ne devine pas.
  if (!best || tie) return null
  return best
}
