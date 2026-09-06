import { randomBytes } from 'node:crypto'

// Identifiant d'enregistrement compact, à la manière d'Airtable
// (`recB4Fehk9jYd4s4B`) : un préfixe de trois lettres suivi de 14 caractères
// alphanumériques. 17 caractères au lieu des 36 d'un UUID — les URL de fiches
// (`/companies/borB4Fehk9jYd4s4B`), les libellés de débogage et les colonnes de
// liens deviennent lisibles.
//
// POURQUOI PAS LE PRÉFIXE `rec` : `rec` + 14 caractères est EXACTEMENT la forme
// d'un record ID Airtable, et l'ERP s'appuie sur cette forme pour distinguer
// « cette clé désigne l'`airtable_id` » de « cette clé désigne l'`id` ERP »
// (services/recordLinks.js, services/airtableNativeMappedColumns.js,
// routes/orders.js, client/src/components/LinkCellEditor.jsx). Les deux
// identités cohabitant sur chaque enregistrement miroir, un id ERP déguisé en
// record ID Airtable rendrait cette distinction impossible. `bor` (Boréal) garde
// la compacité et lève l'ambiguïté. Un seul endroit à changer si l'on veut un
// autre préfixe : PREFIX ci-dessous.
const PREFIX = 'bor'
const LEN = 14

// Base 62. 62 × 4 = 248 : on rejette les octets ≥ 248 pour que chaque caractère
// soit équiprobable (un simple modulo biaiserait les 8 premiers). 14 caractères
// ≈ 83 bits d'entropie, soit largement de quoi ne jamais collisionner à
// l'échelle de la base.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LIMIT = 256 - (256 % ALPHABET.length)

export function newRecordId(prefix = PREFIX) {
  let out = ''
  while (out.length < LEN) {
    for (const b of randomBytes(LEN)) {
      if (b >= LIMIT) continue
      out += ALPHABET[b % ALPHABET.length]
      if (out.length === LEN) break
    }
  }
  return prefix + out
}

// Reconnaît un id produit ici — utile pour trancher, devant une clé, entre id
// ERP et record ID Airtable sans interroger la base.
const RECORD_ID = new RegExp(`^${PREFIX}[0-9A-Za-z]{${LEN}}$`)
export function isCompactRecordId(v) {
  return typeof v === 'string' && RECORD_ID.test(v)
}
