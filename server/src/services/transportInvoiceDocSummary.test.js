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

// Facture 252974 : le sommaire passe sur DEUX colonnes dès qu'il y a beaucoup de
// frais. Lire la seule colonne de droite donnait 51,66 $ de sous-total au lieu de
// 115,83 $ — un « écart » affiché sur une facture pourtant conforme.
const NOVO_2COL = `Numéro de compte           Numéro de facture        Date de facturation     Page
GAP2308                    252974                   16 sept. 2026           1 de 5

Montant total dû                                  120,92

Sommaire des frais d'éxpédition
Frais de Base                                        37,50           Droits                                1,25
Surch. Carburant                                     12,87           Ajustements                          28,85
Zone Résidentiel                                      2,20           T.P.S. (5%) - 784615486RT0001         2,74
PGA Disclaim Fee                                      3,46           T.V.Q. (9,975%) - 1225170467TQ0001    2,35
Surcharge pour droits et taxes de transit             8,14           T.V.P. (7%) -                         2,18
frais de débours                                     19,38
`

test('sommaire imprimé sur deux colonnes', () => {
  const r = parseTransportInvoiceSummary(NOVO_2COL)
  assert.equal(r.tps, 2.74)
  assert.equal(r.tvq, 2.35)
  assert.equal(r.non_recoverable, 2.18) // T.V.P. — reste dans le coût
  assert.equal(r.subtotal, 115.83)
  assert.equal(round2(r.subtotal + r.tps + r.tvq), r.total_due)
})

// Facture de téléphonie Bell : elle imprime « Sommaire des frais courants » et
// une charge, mais pas de montant total dû ni de ligne de taxe nommée. Lue comme
// un sommaire de transport, elle faisait apparaître deux écarts (TPS et TVQ
// « absentes du papier ») sur une facture parfaitement saisie.
const BELL = `    Solde                                                                 0,00 $
    Sommaire des frais courants
    Frais mensuels                                                        171,20
    Utilisation et interurbain                                              0,00
    Total des taxes des frais courants                                     25,63
    Total frais courants         taxes compr.                           196,83 $
`

test('facture de téléphonie : pas un sommaire de transport, rien à confronter', () => {
  assert.equal(parseTransportInvoiceSummary(BELL), null)
})
