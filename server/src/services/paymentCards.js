import db from '../db/database.js'

// ── Cartes de paiement connues ────────────────────────────────────────────────
// Une facture imprime presque toujours les 4 derniers chiffres de la carte qui
// l'a payée (« VISA ****6015 », « MC se terminant par 4823 »). Ce registre dit à
// quel compte QuickBooks ces 4 chiffres correspondent : le compte de la carte
// pour une carte de l'entreprise, le compte « <Nom> (rembourser à) » quand un
// employé a avancé la dépense avec sa carte personnelle.

export function listCards({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'AND active=1'
  return db.prepare(`SELECT * FROM payment_cards WHERE deleted_at IS NULL ${where}
    ORDER BY ownership DESC, holder COLLATE NOCASE, last4`).all()
}

export function getCardByLast4(last4) {
  return db.prepare('SELECT * FROM payment_cards WHERE last4=? AND active=1 AND deleted_at IS NULL').get(String(last4 || ''))
}

// Les 4 chiffres ne sont une carte que s'ils sont ANNONCÉS comme tels : masque
// (****1234, ••1234, xxxx-1234), ou formule explicite (« se terminant par »,
// « ending in », « card 1234 »). Un numéro de facture à 4 chiffres ne doit
// jamais être pris pour une carte — d'où l'absence de « 4 chiffres nus ».
const PATTERNS = [
  /(?:[*x•·#]\s*){2,}\s*[-–—]?\s*(\d{4})\b/gi,
  /(?:se\s+terminant\s+par|finissant\s+par|terminée?\s+par|ending\s+(?:in|with)|last\s*4\s*(?:digits)?\s*:?)\s*[*x•·#\-\s]*(\d{4})\b/gi,
  /\b(?:visa|mastercard|master\s?card|mc|amex|american\s+express|interac|d[ée]bit|carte|card)\b[^\d\n]{0,24}(\d{4})\b/gi,
]

// Tous les groupes de 4 chiffres présentés comme un numéro de carte, dans l'ordre
// de lecture et sans doublon.
export function extractCardLast4(text) {
  const s = String(text || '')
  if (!s) return []
  const out = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      if (!out.includes(m[1])) out.push(m[1])
    }
  }
  return out
}

// La carte reconnue dans un texte (mode de paiement extrait, notes, texte brut),
// ou null. Premier numéro connu du registre : deux cartes différentes citées sur
// le même document est un cas qu'on préfère laisser à l'opérateur, on renvoie la
// première reconnue.
export function matchCardInText(text) {
  for (const last4 of extractCardLast4(text)) {
    const card = getCardByLast4(last4)
    if (card) return card
  }
  return null
}

// La carte d'un reçu : le numéro déjà extrait par la lecture du document prime,
// sinon on relit le mode de paiement et les notes.
export function matchCardForReceipt(rec) {
  if (!rec) return null
  if (rec.card_last4) {
    const card = getCardByLast4(rec.card_last4)
    if (card) return card
  }
  return matchCardInText([rec.payment_method, rec.memo, rec.notes].filter(Boolean).join(' \n '))
}
