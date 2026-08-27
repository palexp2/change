// Normalisation des factures Amazon Web Services Canada.
// Cas de référence : les vraies factures CAIN26-1967781 (août 2026, période juillet)
// et CAIN26-1708886 (juillet 2026, période juin), toutes deux bi-devises USD/CAD.
// L'invariant : on ne retient QUE la colonne USD — c'est en USD qu'AWS est
// comptabilisé (fournisseur QB « Amazon Web Services - USD »).

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAwsInvoice, applyAwsInvoice } from './awsInvoice.js'

// Extrait fidèle de pdftotext -layout sur CAIN26-1967781.pdf.
const INVOICE_1967781 = `
Account number / Numéro de compte :                          Invoice Summary / Résumé de la facture
471112508791                                                 Invoice Number: / Numéro de facture :                         CAIN26-1967781
                                                             Tax Invoice Date: / Date de la facture                            2026/08/01
Address / Adresse :                                          ﬁscale :
Orisha                                                       TOTAL AMOUNT / MONTANT TOTAL                                      CAD 102.73

This Invoice is for the billing period 2026/07/01 - 2026/07/31 / Cette facture
porte sur la période de facturation allant du 2026/07/01 au 2026/07/31
You have selected CAD as your preferred payment currency.

Invoice Summary / Résumé de la facture
AWS Service Charges / Frais de service AWS (1 USD = 1.42521978296 CAD)                        USD 72.08         CAD 102.73
   Charges / Frais                                                                             USD 62.69         CAD 89.35
      Net Charges (After Credits/Discounts, excl. Tax) / Frais nets (après crédits et          USD 62.69         CAD 89.35
      rabais, hors taxes)
      Total taxes / Montant total des taxes                                                     USD 9.39         CAD 13.38
         Total GST Amount at 5% / Montant total de la TPS (5 %)                                 USD 3.14          CAD 4.47
         Total QST Amount at 9.975% / Montant total de la TVQ (9.975 %)                         USD 6.25          CAD 8.91

Detail / Détail
Amazon Elastic Compute Cloud / Amazon Elastic Compute Cloud                                                      USD 67.80
                                                           Amazon Web Services Canada, Inc.
                                             120 Bremner Blvd, 26th Floor, Toronto, ON, M5J 0A8, Canada
`

// CAIN26-1708886 : le mois où le push QB était parti à 49,04 USD au lieu de 69,68.
const INVOICE_1708886 = `
Invoice Number: / Numéro de facture :                         CAIN26-1708886
Tax Invoice Date: / Date de la facture                            2026/07/01
TOTAL AMOUNT / MONTANT TOTAL                                       CAD 98.86
This Invoice is for the billing period 2026/06/01 - 2026/06/30
AWS Service Charges / Frais de service AWS (1 USD = 1.41887049573 CAD)         USD 69.68          CAD 98.86
   Charges / Frais                                                              USD 60.60         CAD 85.98
      Net Charges (After Credits/Discounts, excl. Tax) / Frais nets             USD 60.60         CAD 85.98
      Total taxes / Montant total des taxes                                      USD 9.08         CAD 12.88
         Total GST Amount at 5% / Montant total de la TPS (5 %)                  USD 3.03          CAD 4.30
         Total QST Amount at 9.975% / Montant total de la TVQ (9.975 %)          USD 6.05          CAD 8.58
Amazon Web Services Canada, Inc.
`

// Le courriel « Billing Statement Available » : même montant CAD, aucune colonne USD,
// aucun numéro de facture. Ne doit JAMAIS être pris pour une facture.
const BILLING_STATEMENT_EMAIL = `
Amazon Web Services Billing Statement Available [Account: 471112508791] / Relevé de
facture Amazon Web Services disponible [Compte: 471112508791]
De : Amazon Web Services <invoicing@aws.com>
This e-mail confirms that your latest billing statement is available on the AWS web site.
Total in CAD: $102.73*
This message was produced and distributed by Amazon Web Services Canada, Inc.
`

test('parseAwsInvoice retient la colonne USD, pas l\'équivalent CAD', () => {
  const r = parseAwsInvoice(INVOICE_1967781)
  assert.equal(r.invoiceNumber, 'CAIN26-1967781')
  assert.equal(r.currency, 'USD')
  assert.equal(r.subtotal, 62.69)
  assert.equal(r.tps, 3.14)
  assert.equal(r.tvq, 6.25)
  assert.equal(r.otherTaxes, 0)
  assert.equal(r.total, 72.08)
  // L'équivalent CAD reste lisible pour le rapprochement bancaire, jamais comptabilisé.
  assert.equal(r.cadTotal, 102.73)
  assert.equal(r.fxRate, 1.42521978296)
})

test('parseAwsInvoice fait boucler l\'invariant subtotal + taxes = total', () => {
  for (const text of [INVOICE_1967781, INVOICE_1708886]) {
    const r = parseAwsInvoice(text)
    assert.equal(Math.round((r.subtotal + r.tps + r.tvq + r.otherTaxes) * 100) / 100, r.total)
  }
})

test('parseAwsInvoice lit la date de facture et la période de facturation', () => {
  const r = parseAwsInvoice(INVOICE_1967781)
  assert.equal(r.invoiceDate, '2026-08-01')
  assert.equal(r.periodStart, '2026-07-01')
  assert.equal(r.periodEnd, '2026-07-31')
  // La facture du 1er août couvre le mois de JUILLET.
  assert.equal(r.period, 'juillet 2026')

  const prev = parseAwsInvoice(INVOICE_1708886)
  assert.equal(prev.invoiceDate, '2026-07-01')
  assert.equal(prev.period, 'juin 2026')
  assert.equal(prev.total, 69.68)
})

test('parseAwsInvoice ignore le courriel « Billing Statement Available »', () => {
  assert.equal(parseAwsInvoice(BILLING_STATEMENT_EMAIL), null)
})

test('parseAwsInvoice ignore un document non-AWS ou vide', () => {
  assert.equal(parseAwsInvoice(''), null)
  assert.equal(parseAwsInvoice(null), null)
  assert.equal(parseAwsInvoice('Facture Bell Canada — Total 142,30 $'), null)
})

test('parseAwsInvoice refuse un layout qui ne boucle pas', () => {
  const broken = INVOICE_1967781.replace('USD 62.69         CAD 89.35\n      Net', 'USD 42.69         CAD 89.35\n      Net')
    .replace('USD 62.69         CAD 89.35\n      rabais', 'USD 42.69         CAD 89.35\n      rabais')
  const r = parseAwsInvoice(broken)
  // Sous-total incohérent avec le total : on ne force rien, l'IA + l'opérateur tranchent.
  assert.equal(r, null)
})

test('applyAwsInvoice réécrit l\'extraction IA panachée (montants CAD, currency USD)', () => {
  // Ce que l'IA avait produit pour CAIN26-1967781 : les montants CAD sous le code USD.
  const aiExtracted = {
    company: 'Amazon Web Services Canada, Inc.',
    receipt_date: '2026-08-01',
    receipt_number: 'CAIN26-1967781',
    general_description: 'Frais de service AWS pour la période de facturation',
    subtotal: 89.35, tps: 4.47, tvq: 8.91, other_taxes: 0, total: 102.73,
    currency: 'USD',
    items: [],
  }
  const { extracted, items, applied } = applyAwsInvoice(aiExtracted, [], INVOICE_1967781)
  assert.equal(applied, true)
  assert.equal(extracted.currency, 'USD')
  assert.equal(extracted.subtotal, 62.69)
  assert.equal(extracted.tps, 3.14)
  assert.equal(extracted.tvq, 6.25)
  assert.equal(extracted.total, 72.08)
  assert.equal(extracted.company, 'Amazon Web Services')
  assert.equal(extracted.service_period, 'juillet 2026')
  assert.equal(extracted.transaction_type, 'achat_num_inscrit_taxe')
  // Une seule ligne de dépense, au sous-total HT — forme des Purchase QB déjà publiés.
  assert.deepEqual(items, [{ description: 'Frais de service AWS', quantity: null, unit_price: null, total: 62.69 }])
})

test('applyAwsInvoice laisse passer un document non-AWS sans y toucher', () => {
  const other = { company: 'Bell', total: 142.3, currency: 'CAD' }
  const otherItems = [{ description: 'Téléphonie', total: 142.3 }]
  const r = applyAwsInvoice(other, otherItems, 'Facture Bell Canada')
  assert.equal(r.applied, false)
  assert.equal(r.extracted, other)
  assert.equal(r.items, otherItems)
})
