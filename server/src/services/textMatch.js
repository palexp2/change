// ── Primitives de rapprochement texte ↔ relevé bancaire ─────────────────────
// Écrites d'abord pour les encaissements clients (bankInvoiceMatch.js), elles
// servent maintenant aussi aux dépenses (bankReceiptMatch.js) : un seul jeu de
// règles de normalisation, de mots vides et de tolérance de montant, sinon les
// deux sens du rapprochement se mettent à juger différemment le même libellé.
export const AMOUNT_EPS = 0.02

// Mots qui ne distinguent aucune entreprise : les ignorer évite qu'« Inc. » ou
// « Les Serres » fasse ressembler tout le monde à tout le monde.
export const STOP = new Set([
  'INC', 'INC.', 'LTD', 'LTEE', 'LTD.', 'LIMITED', 'LIMITEE', 'ENR', 'SENC', 'SENCRL',
  'CORP', 'CORPORATION', 'COMPANY', 'CO', 'GROUPE', 'GROUP', 'LES', 'LE', 'LA', 'DES',
  'DE', 'DU', 'ET', 'AND', 'THE', 'SOCIETE', 'ENTREPRISE', 'ENTREPRISES', 'FERME',
  'FERMES', 'SERRE', 'SERRES', 'PRODUCTIONS', 'PRODUCTION', 'CANADA', 'QUEBEC',
])

// Ce que la banque écrit autour du montant, débarrassé des accents et de la
// ponctuation. Les bornes de mots sont gardées : un nom tronqué par la banque
// (« BIOTALENT CANAD ») doit encore pouvoir amorcer « Biotalent Canada ».
export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

export function nameTokens(s) {
  return normalizeText(s).split(' ').filter(t => t.length >= 3 && !STOP.has(t))
}

// Force du rapprochement entre le nom d'une entreprise et le texte du relevé.
// Un jeton compte s'il est écrit tel quel, ou si le relevé en porte un début
// d'au moins 5 lettres (la banque tronque ses champs).
export function nameMatch(companyName, bankText) {
  const tokens = nameTokens(companyName)
  if (!tokens.length) return { hits: 0, ratio: 0 }
  const words = normalizeText(bankText).split(' ').filter(Boolean)
  let hits = 0
  for (const t of tokens) {
    const found = words.some(w => w === t
      || (w.length >= 5 && t.startsWith(w))
      || (t.length >= 5 && w.startsWith(t)))
    if (found) hits += 1
  }
  return { hits, ratio: hits / tokens.length }
}

// Le meilleur de plusieurs noms pour la même entreprise : sa raison sociale et
// les alias de son profil fournisseur. Le nom retenu revient avec le score,
// c'est lui qu'on affiche comme raison.
export function bestNameMatch(names, text) {
  let best = { hits: 0, ratio: 0, name: null }
  for (const n of names || []) {
    if (!n) continue
    const m = nameMatch(n, text)
    if (m.ratio > best.ratio || (m.ratio === best.ratio && m.hits > best.hits)) best = { ...m, name: n }
  }
  return best
}

// Nom compacté : « digikey » au relevé pour « Digi-Key » au profil. Les jetons
// vides de sens ne comptent pas, et un fragment court ne suffit jamais.
export function containsCompact(text, needle, minLen = 5) {
  const compact = nameTokens(needle).join('')
  if (compact.length < minLen) return false
  return normalizeText(text).replace(/ /g, '').includes(compact)
}

export function bankText(txn) {
  return [txn?.description, txn?.details, txn?.reference].filter(Boolean).join(' ')
}

export function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.round((new Date(`${String(b).slice(0, 10)}T00:00:00Z`) - new Date(`${String(a).slice(0, 10)}T00:00:00Z`)) / 86400000)
}

export function round2(n) { return Math.round(n * 100) / 100 }

// ── Libellés gouvernementaux ─────────────────────────────────────────────────
// L'Agence du revenu du Canada ne s'écrit jamais en toutes lettres au relevé :
// la BNC met « REMB. IMPOT · CANADA », d'autres « CANADA FED » ou « CRA/ARC ».
// Ces libellés ne vivent pas dans un profil fournisseur (demande de Charles,
// 2026-09-22) : ils sont connus d'avance, pour tout organisme fiscal.
const GOV_BODIES = [
  {
    // Fédéral : Agence du revenu du Canada, Receveur général.
    doc: ['AGENCE DU REVENU', 'CANADA REVENUE', 'ARC', 'CRA', 'RECEVEUR GENERAL', 'RECEIVER GENERAL'],
    bank: ['GOUV CANADA', 'GOUVERNEMENT DU CANADA', 'GOVERNMENT OF CANADA', 'CANADA FED', 'FED CANADA',
      'CRA', 'ARC', 'RECEVEUR GENERAL', 'RECEIVER GENERAL', 'AGENCE DU REVENU', 'CANADA REVENUE'],
  },
  {
    // Québec : Revenu Québec (ex-MRQ).
    doc: ['REVENU QUEBEC', 'MINISTERE DU REVENU', 'MRQ'],
    bank: ['REVENU QUEBEC', 'REV QUEBEC', 'MRQ', 'GOUV QUEBEC', 'GOUVERNEMENT DU QUEBEC', 'MINISTERE DU REVENU'],
  },
]
// Communs aux deux paliers : le montant départage.
const GOV_COMMON = ['REMB IMPOT', 'IMPOT', 'IMPOTS', 'TAX REFUND', 'INCOME TAX']

function hasPhrase(text, phrase) {
  return ` ${normalizeText(text)} `.includes(` ${phrase} `)
}

// Le document vient-il d'un organisme fiscal, et le relevé en porte-t-il un
// libellé ? Vrai seulement si les deux.
export function governmentLabelHit(names, text) {
  for (const body of GOV_BODIES) {
    if (!(names || []).some(n => body.doc.some(p => hasPhrase(n, p)))) continue
    if ([...body.bank, ...GOV_COMMON].some(p => hasPhrase(text, p))) return true
  }
  return false
}
