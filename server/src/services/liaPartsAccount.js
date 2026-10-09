// Ligne portant un code LIA = pièce achetée → comptabilisée au compte 14000 Stock de
// Pièces, d'office (Charles, 2026-10-03 : « si y'a un code LIA pour un document,
// comptabilise automatique dans le compte de pièces »). La règle prime sur le compte
// choisi pour la ligne ou le document : une pièce suivie dans la table Achats ne se
// passe jamais en dépense.
//
// Appliquée à trois moments : extraction d'un document, enregistrement de ses lignes,
// publication QuickBooks (la garantie finale).
import { hasLiaRef } from './purchaseLiaMatch.js'

export const PARTS_ACCTNUM = '14000'

export const isLiaLine = it => !!it?.purchase_id || !!it?.lia_ref || hasLiaRef(it?.description)

// Pose `partsAccountId` sur chaque ligne LIA. Renvoie le même tableau si rien ne change.
export function applyPartsAccount(items, partsAccountId) {
  if (!partsAccountId || !Array.isArray(items)) return items
  const id = String(partsAccountId)
  let changed = false
  const out = items.map(it => {
    if (!isLiaLine(it) || String(it.expense_account_id || '') === id) return it
    changed = true
    return { ...it, expense_account_id: id }
  })
  return changed ? out : items
}

// Toutes les lignes chiffrées sont des pièces : le document lui-même va au 14000.
export function allLinesAreParts(items) {
  const list = (Array.isArray(items) ? items : []).filter(it => Number(it?.total) || Number(it?.unit_price))
  return list.length > 0 && list.every(isLiaLine)
}

// Id QuickBooks du compte 14000 (null si QB injoignable — la règle est alors
// réappliquée à la publication).
export async function resolvePartsAccountId() {
  try {
    const { resolveAccountByAcctNum } = await import('./quickbooks.js')
    return await resolveAccountByAcctNum(PARTS_ACCTNUM)
  } catch {
    return null
  }
}
