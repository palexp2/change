import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { round2Safe as round2 } from '../utils/money.js'

// Vérification du montant total d'un reçu CONTRE LE DOCUMENT lui-même.
//
// POURQUOI : le total affiché sur la fiche est DÉRIVÉ (somme des lignes + taxes) et les
// lignes viennent d'une extraction IA. Toutes les réconciliations existantes sont
// internes à l'extraction (lignes ↔ sous-total ↔ taxes) : si l'IA lit un mauvais total
// imprimé, tout balance… autour d'un montant qui n'est pas celui de la facture (cas réel :
// facture Scaled Instruments à 1 920 $ alors que le « Grand Total » imprimé est 2 054,24 $,
// transport non repris). Ce module relit le TEXTE du document (pdftotext, aucun appel IA)
// et répond à une seule question : le montant affiché figure-t-il sur le papier ?
//
// Déterministe et sans effet de bord : aucune écriture, aucune correction automatique.
// Les documents photographiés (JPG/PNG) et les PDF scannés n'ont pas de couche texte →
// non vérifiables, l'UI n'affiche alors rien.

// Lignes qui portent le MONTANT TOTAL DÛ, du libellé le plus spécifique au plus vague.
const TOTAL_PATTERNS = [
  { weight: 3, re: /(montant\s+(total\s+)?(dû|du|exigible|à\s+payer)|total\s+à\s+payer|solde\s+à\s+payer|net\s+à\s+payer|montant\s+de\s+la\s+facture|invoice\s+amount|amount\s+due|total\s+due|balance\s+due|amount\s+payable|please\s+pay)/i },
  { weight: 2, re: /(grand\s+total|total\s+g[eé]n[eé]ral|total\s+de\s+la\s+facture|total\s+facture|invoice\s+total|order\s+total|total\s+de\s+la\s+commande|total\s+taxes\s+incluses|total\s+incl|amount\s+paid|total\s+paid|payment\s+received)/i },
  { weight: 1, re: /(^|[^a-zà-ÿ])totals?([^a-zà-ÿ]|$)/i },
]

// Libellés à écarter : ce sont des totaux PARTIELS (avant taxes, taxes seules…). Les
// prendre pour le montant dû ferait crier l'alerte sur une facture pourtant correcte.
// « sous- total » avec l'espace de césure de pdftotext compte aussi.
const EXCLUDE_PATTERN = /(sous\s*-?\s*total|sub\s*-?\s*total|total\s+avant|total\s+hors|before\s+tax|total\s+partiel|total\s+(des\s+)?taxes|total\s+tps|total\s+tvq|total\s+tvh|total\s+gst|total\s+qst|total\s+hst|total\s+pst|tax\s+total|total\s+de\s+la\s+tps|total\s+de\s+la\s+tvq|total\s+des\s+articles|valeur\s+en\s+douane|customs\s+value)/i

// Un nombre imprimé : « 76,28 », « 1 234,56 », « 1,234.56 », « 76.28 », « (76,28) ».
// Les groupes de milliers doivent faire EXACTEMENT trois chiffres : sans cette
// contrainte, deux montants voisins d'une même colonne de layout (« 26580     323.81 »)
// se collaient en un seul nombre absurde et le montant devenait introuvable.
const NUMBER_RE = /(?<![\d.,])\(?-?\$?[ \u00a0]?(?:\d{1,3}(?:[ \u00a0'’]\d{3})+|\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?\)?(?!\d)/g

// Devise imprimée sur une ligne — sert à dire « le document est en EUR » plutôt que de
// comparer des pommes et des oranges. Le « $ » nu est ambigu (CAD/USD) → ignoré.
const CURRENCY_TOKENS = [
  { code: 'EUR', re: /(€|\bEUR\b)/i },
  { code: 'GBP', re: /(£|\bGBP\b)/i },
  { code: 'USD', re: /(\bUSD\b|\bUS[ \u00a0]?\$)/i },
  { code: 'CAD', re: /(\bCAD\b|\bC\$)/i },
  { code: 'CHF', re: /\bCHF\b/i },
]

export function currencyOnLine(line) {
  const s = String(line || '')
  return CURRENCY_TOKENS.find(c => c.re.test(s))?.code || null
}

// Normalise un nombre imprimé (séparateurs FR ou EN) en Number. Le dernier séparateur
// suivi de 1 ou 2 chiffres est le séparateur décimal ; les autres sont des milliers.
export function parsePrintedNumber(raw) {
  if (raw == null) return null
  let s = String(raw).trim()
  const negative = /^\(.*\)$/.test(s) || s.includes('-')
  s = s.replace(/[()$\u00a0\s'’-]/g, '')
  if (!s) return null
  const m = s.match(/[.,](\d{1,2})$/)
  let value
  if (m) {
    const intPart = s.slice(0, s.length - m[0].length).replace(/[.,]/g, '')
    if (!/^\d*$/.test(intPart)) return null
    value = Number(`${intPart || '0'}.${m[1]}`)
  } else {
    const intPart = s.replace(/[.,]/g, '')
    if (!/^\d+$/.test(intPart)) return null
    value = Number(intPart)
  }
  if (!Number.isFinite(value)) return null
  return round2(negative ? -value : value)
}

// Un nombre n'est un MONTANT que s'il porte deux décimales ou un signe de devise
// collé (« $120 »). Sans ce filtre, une ligne « Total Due » suivie d'un numéro de
// TVQ ou d'un en-tête « Courant / 30 jours / 60 jours / Total » livrait des montants
// fantômes (1, 90…) et déclenchait une fausse alerte.
export function moneyInLine(line) {
  const out = []
  for (const raw of String(line || '').match(NUMBER_RE) || []) {
    const token = raw.trim()
    const looksLikeMoney = /[.,]\d{2}\)?$/.test(token) || /^\(?-?\$/.test(token)
    if (!looksLikeMoney) continue
    const n = parsePrintedNumber(token)
    if (n != null) out.push(n)
  }
  return out
}

// Candidats « montant total » du document : une entrée par ligne de total, avec son
// libellé, sa devise et son poids (spécificité du libellé). `amount` = dernier nombre
// imprimé (colonne de droite en layout) ; `amounts` = tous les nombres de la ligne,
// parce qu'une facture bi-devise imprime les deux montants sur la même ligne (AWS :
// « Total ... USD 72.08   CAD 102.73 ») et que l'un ou l'autre est légitime.
export function totalCandidates(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim())
  lines.forEach((line, i) => {
    if (!line) return
    if (EXCLUDE_PATTERN.test(line)) return
    const hit = TOTAL_PATTERNS.find(p => p.re.test(line))
    if (!hit) return
    let nums = moneyInLine(line).filter(n => n !== 0)
    // Libellé seul, montant imprimé juste en dessous (colonne étroite : « Total Due »
    // puis « $982.77 ») → on regarde la ligne suivante, à condition qu'elle ne porte
    // qu'un montant (sinon c'est une rangée de tableau, pas le total).
    if (!nums.length) {
      const next = lines.slice(i + 1).find(l => l)
      const nextNums = next && !TOTAL_PATTERNS.some(p => p.re.test(next)) ? moneyInLine(next).filter(n => n !== 0) : []
      if (nextNums.length === 1) nums = nextNums
    }
    if (!nums.length) return
    out.push({
      amount: nums[nums.length - 1],
      amounts: nums,
      label: line.slice(0, 140),
      currency: currencyOnLine(line),
      weight: hit.weight,
    })
  })
  return out
}

// Tous les montants (nombres à 2 décimales) présents dans le document — confirmation
// faible quand aucune ligne « total » n'est identifiable (reçus de caisse en vrac).
export function decimalAmountsInText(text) {
  const out = new Set()
  for (const raw of String(text || '').match(NUMBER_RE) || []) {
    if (!/[.,]\d{2}$/.test(raw.replace(/\)$/, ''))) continue
    const n = parsePrintedNumber(raw)
    if (n != null && n !== 0) out.add(Math.abs(n))
  }
  return [...out]
}

const TOLERANCE = 0.02
const near = (a, b) => Math.abs(round2(Math.abs(a)) - round2(Math.abs(b))) <= TOLERANCE

// Verdict : le montant `amount` est-il celui du document ?
//   'confirmed' — il figure sur une ligne « total » (ou, à défaut de ligne de total
//                 identifiable, quelque part dans le document).
//   'mismatch'  — le document porte un/des totaux, aucun ne correspond → `document_total`
//                 donne le plus probable.
//   'unknown'   — rien de comparable (pas de couche texte, aucun montant lisible).
export function verdictForAmount(text, amount) {
  const amt = round2(Number(amount) || 0)
  const candidates = totalCandidates(text)
  const hasText = String(text || '').trim().length > 0
  if (!hasText || !amt) return { status: 'unknown', document_total: null, matched_label: null, document_currency: null, candidates: [] }

  const matched = candidates.find(c => c.amounts.some(n => near(n, amt)))
  if (matched) {
    return {
      status: 'confirmed',
      document_total: round2(Math.abs(amt)),
      matched_label: matched.label,
      document_currency: matched.currency,
      candidates,
    }
  }
  // Le montant figure-t-il ailleurs dans le document (pas sur une ligne de total) ?
  const present = decimalAmountsInText(text).some(n => near(n, amt))
  // Un désaccord n'est signalé que sur un libellé EXPLICITE (« Grand Total », « Montant
  // dû », « Order Total »…). Un simple « Total » perdu dans un tableau ou un formulaire
  // de douane ne suffit pas : ces documents impriment dix « Total » sans montant dû, et
  // l'alerte devenait du bruit. Dans ce cas, la présence du montant dans le document
  // fait foi.
  const strong = candidates.filter(c => c.weight >= 2)
  // Document qui empile PLUSIEURS factures (PDF Amazon de trois commandes : trois
  // « Total à payer ») : le reçu porte alors leur somme.
  const distinctStrong = [...new Set(strong.map(c => round2(Math.abs(c.amount))))]
  if (distinctStrong.length > 1 && near(distinctStrong.reduce((s, n) => s + n, 0), amt)) {
    return {
      status: 'confirmed',
      document_total: round2(Math.abs(amt)),
      matched_label: `somme des ${distinctStrong.length} totaux du document`,
      document_currency: strong.find(c => c.currency)?.currency || null,
      candidates,
    }
  }
  const pool = strong.length ? strong : (present ? [] : candidates)
  if (pool.length) {
    // Le plus probable : libellé le plus spécifique, puis le plus gros montant (le
    // montant dû domine les totaux intermédiaires d'un même libellé).
    const best = [...pool].sort((a, b) => b.weight - a.weight || Math.abs(b.amount) - Math.abs(a.amount))[0]
    return {
      status: 'mismatch',
      document_total: round2(Math.abs(best.amount)),
      matched_label: best.label,
      document_currency: best.currency,
      candidates,
    }
  }
  return {
    status: present ? 'confirmed' : 'mismatch',
    document_total: null,
    matched_label: null,
    document_currency: null,
    candidates,
  }
}

// ── Lecture du texte du document ──────────────────────────────────────────────

const PDF_EXT = new Set(['.pdf'])
const textCache = new Map() // clé fichiers → texte (pdftotext coûte un spawn)
const CACHE_MAX = 60

// Texte des pages PDF d'un reçu. `pages` : [{ filePath, fileExt }].
export function documentText(pages) {
  const list = (Array.isArray(pages) ? pages : []).filter(p => p && PDF_EXT.has(p.fileExt) && existsSync(p.filePath))
  if (!list.length) return null
  const key = list.map(p => p.filePath).join('|')
  if (textCache.has(key)) return textCache.get(key)
  const parts = []
  for (const p of list) {
    const r = spawnSync('pdftotext', ['-layout', p.filePath, '-'], { encoding: 'utf8', timeout: 20000 })
    const t = r.stdout?.trim() || ''
    if (t) parts.push(t)
  }
  const text = parts.join('\n\n') || null
  if (textCache.size >= CACHE_MAX) textCache.delete(textCache.keys().next().value)
  textCache.set(key, text)
  return text
}

// Vérification complète d'un reçu : lit le document, compare le montant demandé.
export function checkReceiptAmount(pages, amount) {
  const text = documentText(pages)
  const base = { amount: round2(Number(amount) || 0), document_total: null, matched_label: null, document_currency: null }
  if (!text) return { ...base, text_available: false, status: 'unknown' }
  const v = verdictForAmount(text, amount)
  return {
    ...base,
    text_available: true,
    status: v.status,
    document_total: v.document_total,
    matched_label: v.matched_label,
    document_currency: v.document_currency,
  }
}
