import { round2Safe as round2 } from '../utils/money.js'
import { documentText, parsePrintedNumber } from './saleReceiptAmountCheck.js'

// Lecture DÉTERMINISTE du sommaire IMPRIMÉ d'une facture de transport NovoXpress /
// Groupe Alliances et Privilèges (aucun appel IA — pdftotext seulement).
//
// POURQUOI : la fiche montre ce que l'IA a extrait, et jusqu'ici la seule façon de
// valider était de dérouler le PDF (4 pages, une page par transporteur) en comparant
// des colonnes de chiffres à l'œil. Ces factures ont pourtant une 1re page d'une
// régularité parfaite :
//
//   Numéro de compte   Numéro de facture   Date de facturation   Page
//   GAP2308            252755              10 sept. 2026         1 de 4
//   Montant total dû                       106,72
//   Sommaire des frais d'éxpédition
//   Frais de Base                           61,19
//   …
//   T.P.S. (5%) - 784615486RT0001            2,96
//   T.V.Q. (9,975%) - 1225170467TQ0001       5,88
//
// …et une ligne « Total » par expédition sur les pages suivantes. On en tire le
// sommaire du PAPIER, que la fiche affiche en regard du dossier : l'opérateur lit une
// ligne verte au lieu de relire la facture.

const MONTHS = {
  jan: 1, janv: 1, fev: 2, fevr: 2, feb: 2, mar: 3, mars: 3, avr: 4, apr: 4,
  mai: 5, may: 5, juin: 6, jun: 6, juil: 7, jul: 7, aou: 8, aout: 8, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function deaccent(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// « 10 sept. 2026 » → « 2026-09-10 ». null si illisible.
export function parsePrintedFrenchDate(raw) {
  const m = deaccent(raw).match(/(\d{1,2})\s+([a-zA-Zéû.]+)\.?\s+(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[2].toLowerCase().replace(/\./g, '').slice(0, 4)]
    ?? MONTHS[m[2].toLowerCase().replace(/\./g, '').slice(0, 3)]
  if (!month) return null
  const y = Number(m[3])
  if (y < 2000 || y > 2100) return null
  return `${y}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`
}

// Montant en fin de ligne (colonne de droite du layout). null si la ligne n'en porte pas.
function trailingAmount(line) {
  const m = String(line || '').match(/(-?\(?\$?\s?\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{2})\)?)\s*$/)
  return m ? parsePrintedNumber(m[1]) : null
}

const AMOUNT_ONLY = /^-?\(?\$?\s?\d{1,3}(?:[ \u00a0]\d{3})*[.,]\d{2}\)?$/

// Une ligne du sommaire porte UNE ou DEUX paires « libellé … montant » : NovoXpress
// imprime ses frais sur deux colonnes dès qu'il y en a beaucoup
// (« Frais de Base   37,50   Droits   1,25 »). Ne lire que le montant de fin de ligne
// perdait toute la colonne de gauche — sous-total faux, « écart » fantôme sur la fiche.
function summaryPairs(line) {
  const pairs = []
  let label = []
  for (const tok of String(line || '').split(/\s{2,}/).map(t => t.trim()).filter(Boolean)) {
    if (AMOUNT_ONLY.test(tok)) {
      if (label.length) pairs.push({ label: label.join(' ').trim(), amount: parsePrintedNumber(tok) })
      label = []
      continue
    }
    // Libellé et montant séparés par une seule espace (« P.S.T. (7%) 1,00 »).
    const m = tok.match(/^(.*\S)\s+(-?\(?\$?\s?\d{1,3}(?:[ \u00a0]\d{3})*[.,]\d{2}\)?)$/)
    if (m) {
      label.push(m[1])
      pairs.push({ label: label.join(' ').trim(), amount: parsePrintedNumber(m[2]) })
      label = []
    } else {
      label.push(tok)
    }
  }
  return pairs
}

// Ligne « … Total   17,21 » d'une expédition (jamais « Montant total dû », qui ne finit
// pas par le mot Total avant le montant).
const SHIPMENT_TOTAL_RE = /(?:^|\s)Total\s+(-?\(?\$?\s?[\d\u00a0 ',.]+)\s*$/

// À quelle case du dossier va une taxe imprimée. Miroir de transportInvoice.js :
// TPS/GST → tps, TVQ/QST → tvq, TVH/HST → other_taxes. Une PST/RST provinciale n'est
// pas récupérable : elle reste dans le coût, donc dans le sous-total.
function taxField(label) {
  const l = deaccent(label).toUpperCase().replace(/[^A-Z]/g, '')
  if (l.includes('TVQ') || l.includes('QST')) return 'tvq'
  if (l.includes('TVH') || l.includes('HST')) return 'other_taxes'
  if (l.includes('PST') || l.includes('RST') || l.includes('TVP')) return null
  if (l.includes('TPS') || l.includes('GST')) return 'tps'
  return null
}

const IS_TAX_LINE = /\b(T\.?P\.?S\.?|T\.?V\.?Q\.?|T\.?V\.?H\.?|T\.?V\.?P\.?|G\.?S\.?T|Q\.?S\.?T|H\.?S\.?T|P\.?S\.?T|R\.?S\.?T)\b/i

/**
 * Sommaire imprimé d'une facture de transport, ou null si le document n'en est pas une
 * (marqueur « Sommaire des frais » absent, ou PDF sans couche texte).
 */
export function parseTransportInvoiceSummary(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  const lines = raw.split(/\r?\n/)
  const start = lines.findIndex(l => /sommaire\s+des\s+frais/i.test(deaccent(l)))
  if (start < 0) return null

  // Bloc du sommaire : lignes « libellé … montant » jusqu'à la première qui n'en est pas
  // une (la facture enchaîne sur un paragraphe de communication).
  const charges = []
  const taxes = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { if (charges.length || taxes.length) break; continue }
    const pairs = summaryPairs(line)
    if (!pairs.length) break
    for (const { label, amount } of pairs) {
      if (IS_TAX_LINE.test(label)) taxes.push({ label, amount, field: taxField(label) })
      else charges.push({ label, amount })
    }
  }
  if (!charges.length && !taxes.length) return null

  const byField = { tps: 0, tvq: 0, other_taxes: 0 }
  let nonRecoverable = 0
  for (const t of taxes) {
    if (t.field) byField[t.field] = round2(byField[t.field] + t.amount)
    else nonRecoverable = round2(nonRecoverable + t.amount)
  }
  // La taxe non récupérable est repliée dans le coût (cf. transportInvoice.js) : elle
  // appartient au sous-total du dossier, pas aux cases de taxe.
  const subtotal = round2(charges.reduce((s, c) => s + c.amount, 0) + nonRecoverable)

  const dueLine = lines.find(l => /montant\s+total\s+d/i.test(deaccent(l)))
  const totalDue = dueLine ? trailingAmount(dueLine) : null

  // En-tête : la ligne de valeurs suit celle des libellés de colonnes.
  let invoiceNumber = null, invoiceDate = null
  const headIdx = lines.findIndex(l => /numero\s+de\s+facture/i.test(deaccent(l)))
  if (headIdx >= 0) {
    const values = lines.slice(headIdx + 1).find(l => l.trim())
    const numbers = (values || '').trim().split(/\s{2,}/)
    if (numbers[1]) invoiceNumber = numbers[1].trim()
    invoiceDate = parsePrintedFrenchDate(values)
  }

  // Une ligne « Total » par expédition sur les pages de détail. Les expéditions à 0 $
  // (annulations imprimées pour mémoire) ne comptent pas : l'extraction ne les retient
  // pas non plus.
  const shipmentTotals = []
  for (const line of lines) {
    const m = line.match(SHIPMENT_TOTAL_RE)
    if (!m) continue
    const n = parsePrintedNumber(m[1])
    if (n != null && n !== 0) shipmentTotals.push(n)
  }

  // Garde-fou : « Sommaire des frais » n'appartient pas qu'au transport — une
  // facture de téléphonie Bell imprime « Sommaire des frais courants ». On y
  // lisait alors une charge et zéro taxe, et la confrontation inventait deux
  // écarts (TPS et TVQ « manquantes » sur le papier). Une vraie facture de
  // transport porte toujours son « Montant total dû » : sans lui, ce n'en est
  // pas une, et le peu qu'on a lu ne vaut pas confrontation.
  if (totalDue == null) return null

  return {
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    total_due: totalDue,
    subtotal,
    tps: byField.tps,
    tvq: byField.tvq,
    other_taxes: byField.other_taxes,
    non_recoverable: nonRecoverable,
    charges,
    taxes,
    shipment_count: shipmentTotals.length,
    shipment_total_sum: round2(shipmentTotals.reduce((s, n) => s + n, 0)),
  }
}

// Sommaire imprimé des pages d'un reçu. `pages` : [{ filePath, fileExt }].
export function readTransportInvoiceSummary(pages) {
  const text = documentText(pages)
  if (!text) return { available: false, reason: 'no_text' }
  const parsed = parseTransportInvoiceSummary(text)
  if (!parsed) return { available: false, reason: 'not_transport' }
  return { available: true, ...parsed }
}
