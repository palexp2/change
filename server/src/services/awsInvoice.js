import { formatPeriodRange } from './servicePeriod.js'
import { round2Safe as round2 } from '../utils/money.js'

// Factures Amazon Web Services Canada — normalisation déterministe.
//
// POURQUOI un parseur dédié plutôt que l'extraction IA seule : la facture AWS
// affiche CHAQUE montant dans DEUX devises côte à côte (« USD 62.69   CAD 89.35 »),
// parce que la devise de paiement préférée du compte est le CAD alors que la
// facturation reste en USD. L'IA panache : elle a déjà rendu les montants CAD avec
// currency='USD' (août 2026, CAIN26-1967781) et les montants USD avec currency='CAD'
// (juillet 2026, CAIN26-1708886 — publication QB convertie à tort, 69,68 → 49,04).
//
// CONVENTION COMPTABLE (constante depuis sept. 2025, vérifiée sur 11 Purchase QB) :
// AWS se comptabilise TOUJOURS en USD, colonne USD de la facture, sur le fournisseur
// « Amazon Web Services - USD » (Id 1138), carte VISA Desjardins USD (239), dépense
// 70 « Opérations:Services web & téléphonie », code de taxe 8, type de transaction
// achat_num_inscrit_taxe (AWS Canada facture TPS + TVQ et affiche ses numéros
// d'inscription). Les défauts QB vivent dans le profil fournisseur ; ce module ne
// s'occupe que d'ancrer les MONTANTS et la DEVISE sur la colonne USD.
//
// ÉCART BANCAIRE : AWS charge la carte en CAD (devise de paiement préférée du compte),
// que Desjardins reconvertit en USD à SON taux — le débit réel diffère donc souvent du
// total USD de la facture (ex. août 2026 : facture 72,08, banque 73,38). Convention
// (constante sur l'historique QB) : l'écart s'ajoute au push en ligne « Frais de
// conversion » (code Exonéré), via le champ « Montant passé à la banque » du formulaire
// de publication (params.bankChargedTotal de pushSaleReceiptToQB). Les montants du reçu
// restent ceux de la facture — ne PAS les modifier pour absorber l'écart.
//
// Le layout de la facture est stable d'un mois à l'autre (pdftotext -layout) :
//
//   Invoice Number: / Numéro de facture :                    CAIN26-1967781
//   Tax Invoice Date: / Date de la facture ﬁscale :              2026/08/01
//   This Invoice is for the billing period 2026/07/01 - 2026/07/31
//   AWS Service Charges / Frais de service AWS (1 USD = 1.42521978296 CAD)   USD 72.08   CAD 102.73
//      Charges / Frais                                                       USD 62.69   CAD  89.35
//         Total GST Amount at 5% / Montant total de la TPS (5 %)             USD  3.14   CAD   4.47
//         Total QST Amount at 9.975% / Montant total de la TVQ (9.975 %)     USD  6.25   CAD   8.91


// Signature du document : émetteur AWS Canada + un numéro de facture AWS. Le
// « Billing Statement Available » (courriel de notification, pas une facture) ne
// porte ni l'un ni l'autre et n'est donc jamais reconnu ici.
const AWS_ISSUER = /amazon\s+web\s+services(\s+canada)?/i
const INVOICE_NUMBER = /(?:Invoice Number|Num[ée]ro de facture)\s*:?\s*\/?\s*(?:Num[ée]ro de facture\s*:?\s*)?([A-Z]{2,4}\d{2}-?\s?\d{4,})/i
const INVOICE_DATE = /(?:Tax Invoice Date|Date de la facture)[^\n]*?(\d{4})\/(\d{2})\/(\d{2})/i
const BILLING_PERIOD = /billing period\s+(\d{4})\/(\d{2})\/(\d{2})\s*[-–]\s*(\d{4})\/(\d{2})\/(\d{2})/i

// Montant d'une devise donnée sur une ligne : « USD 62.69 », « CAD 1,234.56 »,
// « USD -3.10 ». On prend la DERNIÈRE occurrence de la ligne : les libellés
// bilingues peuvent contenir un pourcentage ou un taux avant les colonnes.
function amountOnLine(line, currency) {
  const re = new RegExp(`${currency}\\s*(-?[\\d,]+\\.\\d{2})`, 'g')
  let last = null
  for (const m of line.matchAll(re)) last = m[1]
  return last === null ? null : round2(Number(last.replace(/,/g, '')))
}

// Première ligne du texte qui matche `labelRe` ET porte un montant dans `currency`.
function findAmount(lines, labelRe, currency) {
  for (const line of lines) {
    if (!labelRe.test(line)) continue
    const amount = amountOnLine(line, currency)
    if (amount !== null) return amount
  }
  return null
}

const L_SERVICE_CHARGES = /AWS Service Charges|Frais de service AWS/i
const L_NET_CHARGES = /Net Charges|Frais nets/i
const L_CHARGES = /^\s*Charges\s*\/\s*Frais|Charges \/ Frais\s+[A-Z]{3}/i
const L_GST = /Total (?:GST|HST) Amount|Montant total de la (?:TPS|TVH)/i
const L_QST = /Total QST Amount|Montant total de la TVQ/i
const L_PST = /Total (?:PST|RST) Amount|Montant total de la (?:TVP|TVD)/i
const L_TAXES = /Total taxes|Montant total des taxes/i

/**
 * Parse une facture AWS depuis le texte brut du PDF (`pdftotext -layout`).
 * Retourne null si le document n'est pas une facture AWS exploitable — l'appelant
 * retombe alors sur l'extraction IA telle quelle.
 *
 * @returns {{invoiceNumber: string|null, invoiceDate: string|null, period: string|null,
 *            periodStart: string|null, periodEnd: string|null, currency: 'USD',
 *            subtotal: number, tps: number, tvq: number, otherTaxes: number, total: number,
 *            cadTotal: number|null, fxRate: number|null}|null}
 */
export function parseAwsInvoice(text) {
  const raw = String(text || '')
  if (!raw || !AWS_ISSUER.test(raw)) return null
  const lines = raw.split('\n')

  const numMatch = INVOICE_NUMBER.exec(raw)
  const invoiceNumber = numMatch ? numMatch[1].replace(/\s+/g, '') : null
  if (!invoiceNumber) return null

  // Le sous-total HT est la ligne « Net Charges / Frais nets » (après crédits et
  // rabais) ; sur les factures sans crédit AWS n'imprime que « Charges / Frais ».
  const subtotal = findAmount(lines, L_NET_CHARGES, 'USD') ?? findAmount(lines, L_CHARGES, 'USD')
  const total = findAmount(lines, L_SERVICE_CHARGES, 'USD')
  if (subtotal === null || total === null) return null

  const tps = findAmount(lines, L_GST, 'USD') ?? 0
  const tvq = findAmount(lines, L_QST, 'USD') ?? 0
  const pst = findAmount(lines, L_PST, 'USD') ?? 0
  // Filet : si AWS facture une taxe qu'on ne sait pas nommer, l'écart entre le total
  // des taxes imprimé et ce qu'on a ventilé atterrit dans other_taxes plutôt que de
  // casser l'invariant subtotal + taxes = total.
  const printedTaxes = findAmount(lines, L_TAXES, 'USD')
  const residual = printedTaxes === null ? 0 : round2(printedTaxes - tps - tvq - pst)
  const otherTaxes = round2(pst + (residual > 0.01 ? residual : 0))

  // Cohérence : la colonne USD doit boucler. Si elle ne boucle pas, le layout a
  // changé — on préfère ne rien forcer et laisser l'extraction IA + l'opérateur.
  if (Math.abs(round2(subtotal + tps + tvq + otherTaxes) - total) > 0.02) return null

  const dateMatch = INVOICE_DATE.exec(raw)
  const invoiceDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null

  const per = BILLING_PERIOD.exec(raw)
  const start = per ? { y: +per[1], m: +per[2], d: +per[3] } : null
  const end = per ? { y: +per[4], m: +per[5], d: +per[6] } : null

  const fx = /1\s*USD\s*=\s*([\d.]+)\s*CAD/i.exec(raw)

  return {
    invoiceNumber,
    invoiceDate,
    period: start && end ? formatPeriodRange(start, end) : null,
    periodStart: per ? `${per[1]}-${per[2]}-${per[3]}` : null,
    periodEnd: per ? `${per[4]}-${per[5]}-${per[6]}` : null,
    currency: 'USD',
    subtotal,
    tps,
    tvq,
    otherTaxes,
    total,
    cadTotal: findAmount(lines, L_SERVICE_CHARGES, 'CAD'),
    fxRate: fx ? Number(fx[1]) : null,
  }
}

/**
 * Réécrit le résultat d'extraction IA d'une facture AWS avec les montants USD
 * lus déterministiquement. Retourne { extracted, items, applied }.
 * `applied` est false quand le document n'est pas une facture AWS reconnue :
 * `extracted` et `items` sont alors rendus inchangés.
 */
export function applyAwsInvoice(extracted, items, sourceText) {
  const parsed = parseAwsInvoice(sourceText)
  if (!parsed) return { extracted, items, applied: false, parsed: null }

  const description = 'Frais de service AWS'
  return {
    parsed,
    applied: true,
    extracted: {
      ...extracted,
      company: 'Amazon Web Services',
      receipt_number: parsed.invoiceNumber,
      receipt_date: parsed.invoiceDate || extracted?.receipt_date || null,
      general_description: description,
      service_period: parsed.period,
      currency: 'USD',
      subtotal: parsed.subtotal,
      tps: parsed.tps,
      tvq: parsed.tvq,
      other_taxes: parsed.otherTaxes,
      total: parsed.total,
      // AWS Canada facture TPS + TVQ et imprime ses numéros d'inscription : le
      // document est toujours un achat numérique auprès d'un inscrit, taxé.
      transaction_type: 'achat_num_inscrit_taxe',
      // Payée automatiquement par carte de crédit (VISA Desjardins USD).
      payment_method: extracted?.payment_method || 'Carte de crédit',
    },
    // Une seule ligne de dépense, au sous-total HT USD — c'est la forme des 11
    // Purchase QB déjà publiés (compte 70, code de taxe 8). Le détail par service
    // (EC2, VPC, KMS…) n'a jamais été ventilé en comptabilité.
    items: [{ description, quantity: null, unit_price: null, total: parsed.subtotal }],
  }
}
