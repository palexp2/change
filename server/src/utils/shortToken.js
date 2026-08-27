import { randomBytes, randomInt } from 'crypto'

// Crockford base32 — sans I, L, O, U pour éviter confusion à l'oral.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// Base62 — format des identifiants Airtable (ex: B4Fehk9jYd4s4B). Réservé aux
// jetons qui voyagent dans une URL et que personne ne dicte à l'oral : la casse
// mixte double l'entropie mais rend le jeton illisible au téléphone.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// Confusion classique → chiffre/lettre canonique (insensible à la casse).
const NORMALIZE_MAP = {
  O: '0', o: '0',
  I: '1', i: '1', L: '1', l: '1',
  U: 'V', u: 'V',
}

// Génère un token de 10 caractères (~50 bits d'entropie).
// 32^10 ≈ 1.13 × 10^15 combinaisons.
export function generateShortToken(length = 10) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % 32]
  }
  return out
}

// Jeton base62 de 14 caractères, format Airtable (~83 bits d'entropie).
// randomInt plutôt que randomBytes % 62 : 256 n'est pas un multiple de 62, le
// modulo biaiserait les 8 premiers caractères de l'alphabet.
export function generateBase62Token(length = 14) {
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)]
  return out
}

// Normalise un token reçu (uppercase, retire séparateurs, corrige O→0, I/L→1, U→V).
export function normalizeShortToken(input) {
  if (!input || typeof input !== 'string') return ''
  let out = ''
  for (const c of input) {
    if (c === '-' || c === ' ') continue
    const mapped = NORMALIZE_MAP[c] ?? c.toUpperCase()
    if (ALPHABET.includes(mapped)) out += mapped
  }
  return out
}

// Format dictable à l'oral : AB12-CDE3-4F (groupes de 4).
export function formatShortTokenForDisplay(token) {
  const n = normalizeShortToken(token)
  return n.match(/.{1,4}/g)?.join('-') ?? n
}
