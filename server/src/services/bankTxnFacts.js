/**
 * Ce que le libellé d'une ligne de relevé dit en clair et qu'on jetait.
 *
 * Deux faits s'y cachent, et ils changent l'écriture qu'on va préparer :
 *
 *  • le MONTANT D'ORIGINE en devise étrangère — « WIX.COM … USA CA Montant
 *    initial en devise USD 37,49 » pour un débit de 54,51 $ CA. Sans lui, le
 *    taux de change appliqué par la banque est invisible et la ligne ne peut
 *    pas être rapprochée d'une facture libellée en dollars US ;
 *  • le NUMÉRO DE CHÈQUE — « CHEQUE NO 15 », ou « CHEQUE NO » avec le numéro
 *    rangé dans la colonne référence. C'est le numéro de pièce de l'écriture.
 *
 * Fonctions pures : aucune base, aucun réseau. Utilisées à l'import (pour
 * remplir les colonnes) ET à la lecture d'une ligne importée avant ces
 * colonnes, ce qui évite toute reprise de l'historique.
 */

// « Montant initial en devise USD 37,49 » / « in foreign currency USD 37.49 ».
const FOREIGN = /(?:montant initial en devise|initial amount in|foreign currency)\s+([A-Z]{3})\s+(\d[\d\s.,]*)/i

export function extractForeignAmount(text) {
  const m = FOREIGN.exec(String(text || ''))
  if (!m) return null
  // Le relevé BNC écrit « 1 234,56 » ; le séparateur décimal est la virgule.
  const raw = m[2].trim().replace(/[\s]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(/,/g, '.')
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount === 0) return null
  return { currency: m[1].toUpperCase(), amount: Math.round(amount * 100) / 100 }
}

// Le numéro peut suivre « CHEQUE NO » dans le libellé, ou vivre seul dans la
// colonne référence quand le libellé s'arrête à « CHEQUE NO ». On ne prend la
// référence QUE si elle n'est que des chiffres : sur ces lignes elle porte
// souvent le bénéficiaire (« CT Greenhouse »).
export function extractCheckNumber(description, reference) {
  const d = String(description || '')
  const m = /ch[eè]?que\s*(?:n[o°]?\.?)?\s*#?\s*(\d{1,8})\b/i.exec(d)
  if (m) return m[1]
  if (!/ch[eè]?que/i.test(d)) return null
  const ref = String(reference || '').trim()
  return /^\d{1,8}$/.test(ref) ? ref : null
}

// Les faits d'une ligne, colonnes d'abord, libellé en repli.
export function txnFacts(txn) {
  const label = [txn?.description, txn?.details].filter(Boolean).join(' ')
  const foreign = txn?.orig_currency && txn?.orig_amount
    ? { currency: txn.orig_currency, amount: txn.orig_amount }
    : extractForeignAmount(label)
  const check = txn?.check_number || extractCheckNumber(txn?.description, txn?.reference)
  return { foreign, check }
}
