// Conversion de devise d'une facture — reprise de l'onglet « USD_CAD » du
// Google Sheets « CTB - Suivi ».
//
// Situation type : la facture est libellée dans une devise (USD) mais la carte
// est chargée dans une autre (CAD). Le taux appliqué par l'émetteur de la carte
// inclut ses frais de conversion, donc il ne correspond pas au taux du marché :
// le seul taux exact est celui DÉRIVÉ du montant réellement débité
//   taux = montant débité ÷ total de la facture
// puis appliqué ligne par ligne (sous-total, TPS, TVQ, autres taxes) pour que la
// ventilation en devise cible retombe au cent près sur le montant débité —
// c'est la colonne « Contrôle » du sheet, qui doit valoir 0.
//
// Exécution des tests : `node --test client/src/lib/currencyConversion.test.js`

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// Analyse un montant saisi à la main, en acceptant les conventions FR et EN :
// « 196,14 », « 196.14 », « 1 196,14 », « 1 196.14 », « 1,196.14 », « 1.196,14 »,
// avec espaces insécables, symboles de devise et signe. Règle de départage :
// le DERNIER séparateur rencontré est le séparateur décimal, sauf s'il délimite
// un groupe de milliers (exactement 3 chiffres derrière et répété/précédé d'un
// groupe régulier) — « 1,196 » vaut donc 1196, « 196,14 » vaut 196,14.
export function parseAmount(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  // \u00A0 / \u202F : espaces insécables des montants collés d'un PDF ou d'Excel.
  let s = String(v).trim().replace(/[\s\u00A0\u202F\u2009]/g, '').replace(/[$€£]|CAD|USD|EUR|GBP/gi, '')
  if (!s) return null
  const neg = /^[-(]/.test(s)
  s = s.replace(/[()-]/g, '')
  if (!/^[\d.,]+$/.test(s)) return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  const lastSep = Math.max(lastComma, lastDot)
  let decimalSep = null
  if (lastSep >= 0) {
    const decimals = s.length - lastSep - 1
    const bothKinds = lastComma >= 0 && lastDot >= 0
    const sepChar = lastSep === lastComma ? ',' : '.'
    const occurrences = s.split(sepChar).length - 1
    // Un séparateur unique suivi d'exactement 3 chiffres est ambigu (« 1,196 ») :
    // c'est un séparateur de milliers dès qu'il n'y a pas d'autre séparateur.
    const looksLikeThousands = !bothKinds && decimals === 3 && (occurrences > 1 || /^\d{1,3}(?:[.,]\d{3})+$/.test(s))
    if (!looksLikeThousands) decimalSep = sepChar
  }

  let normalized
  if (decimalSep) {
    const head = s.slice(0, lastSep).replace(/[.,]/g, '')
    normalized = `${head || '0'}.${s.slice(lastSep + 1)}`
  } else {
    normalized = s.replace(/[.,]/g, '')
  }
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

function num(v) {
  const n = parseAmount(v)
  return n == null ? 0 : n
}

// Ventile une facture d'une devise vers une autre.
//
// Entrées : les composantes de la facture en devise source, et SOIT le montant
// réellement débité en devise cible (`targetTotal` — cas normal, le taux en est
// déduit), SOIT un taux (`rate` — pour projeter une conversion à venir).
//
// Sortie : { ok, rate, sourceTotal, targetTotal, lines, adjustment, control }
//  - `lines` : les mêmes composantes converties et arrondies au cent ;
//  - `adjustment` : résidu d'arrondi reporté sur le sous-total (≤ 1 ¢ par ligne) ;
//  - `control` : écart entre la somme des lignes converties et le montant cible.
//    Toujours 0 quand `ok` — c'est l'invariant que le sheet vérifiait à la main.
export function computeConversion({
  subtotal = 0, tps = 0, tvq = 0, otherTaxes = 0,
  total = null, targetTotal = null, rate = null,
} = {}) {
  const parts = { subtotal: num(subtotal), tps: num(tps), tvq: num(tvq), otherTaxes: num(otherTaxes) }
  const partsSum = round2(parts.subtotal + parts.tps + parts.tvq + parts.otherTaxes)
  const sourceTotal = total == null || total === '' ? partsSum : round2(num(total))

  const empty = { ok: false, rate: null, sourceTotal, targetTotal: null, lines: null, adjustment: 0, control: 0 }
  if (!(sourceTotal > 0)) return { ...empty, error: 'Le total de la facture doit être supérieur à 0.' }

  let effRate, target
  const wantTarget = targetTotal != null && targetTotal !== ''
  if (wantTarget) {
    const parsed = parseAmount(targetTotal)
    if (parsed == null) return { ...empty, error: 'Montant débité invalide.' }
    target = round2(parsed)
    if (!(target > 0)) return { ...empty, error: 'Le montant débité doit être supérieur à 0.' }
    effRate = target / sourceTotal
  } else {
    effRate = parseAmount(rate)
    if (!Number.isFinite(effRate) || effRate <= 0) {
      return { ...empty, error: 'Saisissez le montant débité ou un taux de conversion.' }
    }
    target = round2(sourceTotal * effRate)
  }

  const lines = {
    subtotal: round2(parts.subtotal * effRate),
    tps: round2(parts.tps * effRate),
    tvq: round2(parts.tvq * effRate),
    otherTaxes: round2(parts.otherTaxes * effRate),
  }
  // Résidu d'arrondi : reporté sur le sous-total (la plus grosse composante),
  // jamais sur les taxes — une taxe convertie doit rester le produit exact de sa
  // base par le taux, sinon la réconciliation TPS/TVQ au push QB dérape.
  const sum = round2(lines.subtotal + lines.tps + lines.tvq + lines.otherTaxes)
  const adjustment = round2(target - sum)
  lines.subtotal = round2(lines.subtotal + adjustment)

  const control = round2(target - round2(lines.subtotal + lines.tps + lines.tvq + lines.otherTaxes))
  return { ok: true, error: null, rate: effRate, sourceTotal, targetTotal: target, lines, adjustment, control }
}

// Écart (en %) entre le taux effectivement subi et le taux du marché à la date
// de la transaction : c'est, en pratique, la commission de conversion de la carte.
// Retourne null si l'un des deux taux manque.
export function conversionSpreadPct(effectiveRate, marketRate) {
  const e = Number(effectiveRate), m = Number(marketRate)
  if (!Number.isFinite(e) || !Number.isFinite(m) || m <= 0) return null
  return Math.round(((e - m) / m) * 10000) / 100
}
