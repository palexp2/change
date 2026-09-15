import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTransportInvoiceSummary, parsePrintedFrenchDate } from './transportInvoiceDocSummary.js'

// Extrait fidèle d'une facture NovoXpress (pdftotext -layout), réduit à deux expéditions.
const NOVO = `Numéro de compte         Numéro de facture        Date de facturation      Page
GAP2308                  252755                    10 sept. 2026           1 de 4

Orisha

Montant total dû                                 106,72
Date dû                                   25 sept. 2026

Sommaire des frais d'éxpédition
Rabais Volume                                        5,56
Frais de Base                                       61,19
Surch. Carburant                                    23,70
Zone Résidentiel                                     2,40
Livraison residentiel                                1,33
Frais de courtage/douaniers                          3,70
T.P.S. (5%) - 784615486RT0001                        2,96
T.V.Q. (9,975%) - 1225170467TQ0001                   5,88

Nous sommes heureux de vous annoncer que notre service de transport…

Purolator - Expeditions
02 sept. 2026   Automatisation Orisha Inc.    Nature Bonsai        1 pc   T.V.Q.     2,90
                                                                          Total     33,48
01 janv. 0001   Ferme La Baigneuse            Orisha               0 pc   Total       0,00
28 août 2026    Orisha                        Meacham urban farm   1 pc   Total      38,82
`

test('lit le sommaire imprimé d’une facture NovoXpress', () => {
  const r = parseTransportInvoiceSummary(NOVO)
  assert.equal(r.invoice_number, '252755')
  assert.equal(r.invoice_date, '2026-09-10')
  assert.equal(r.total_due, 106.72)
  assert.equal(r.tps, 2.96)
  assert.equal(r.tvq, 5.88)
  assert.equal(r.other_taxes, 0)
  // Sous-total = somme des lignes de frais (taxes exclues).
  assert.equal(r.subtotal, 97.88)
  assert.equal(round2(r.subtotal + r.tps + r.tvq), r.total_due)
})

test('les expéditions à 0 $ ne comptent pas', () => {
  const r = parseTransportInvoiceSummary(NOVO)
  assert.equal(r.shipment_count, 2)
  assert.equal(r.shipment_total_sum, 72.3)
})

test('la TVH va dans « autres taxes », la PST reste dans le coût', () => {
  const text = NOVO.replace('T.P.S. (5%) - 784615486RT0001                        2,96',
    'T.V.H. (15%) - 784615486RT0001                       3,47\nP.S.T. (7%)                                          1,00')
  const r = parseTransportInvoiceSummary(text)
  assert.equal(r.other_taxes, 3.47)
  assert.equal(r.tps, 0)
  assert.equal(r.non_recoverable, 1)
  assert.equal(r.subtotal, 98.88) // 97,88 de frais + la PST non récupérable
})

test('un document qui n’est pas une facture de transport ne rend rien', () => {
  assert.equal(parseTransportInvoiceSummary('Invoice\nTotal Due 120.00'), null)
  assert.equal(parseTransportInvoiceSummary(''), null)
})

test('dates françaises abrégées', () => {
  assert.equal(parsePrintedFrenchDate('10 sept. 2026'), '2026-09-10')
  assert.equal(parsePrintedFrenchDate('5 août 2026'), '2026-08-05')
  assert.equal(parsePrintedFrenchDate('1 janv. 0001'), null)
})

const round2 = x => Math.round(x * 100) / 100
