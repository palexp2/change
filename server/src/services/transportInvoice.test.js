// Reconstruction des lignes d'une facture de transport multi-expéditions,
// regroupées PAR PROVINCE / PAYS de destination.
// Cas de référence : les vraies factures NovoXpress / Groupe Alliances et Privilèges
// 250259 (7 pages, QC + export) et 250715 (7 pages, QC/NB/ON/BC + export + CRÉDIT UPS).
// L'invariant fiscal doit boucler exactement au « Montant total dû » de chaque facture.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransportInvoice, classifyTax } from './transportInvoice.js'

test('classifyTax reconnaît les libellés malgré la ponctuation', () => {
  assert.equal(classifyTax('T.P.S. (5%) - 784615486RT0001'), 'gst')
  assert.equal(classifyTax('T.V.Q. (9,975%) - 1225170467TQ0001'), 'qst')
  assert.equal(classifyTax('TVH'), 'hst')
  assert.equal(classifyTax('PST (BC)'), 'pst')
  assert.equal(classifyTax('T.V.P. (7%) -'), 'pst')
  assert.equal(classifyTax('Frais bizarres'), 'other')
})

// Données réelles de la facture 250259 (un envoi par page, taxes telles qu'imprimées).
const SAMPLE_250259 = [
  { carrier: 'Postes Canada', destination_province: 'QC', destination_country: 'CA', total: 19.02, taxes: [{ label: 'T.P.S.', amount: 0.83 }, { label: 'T.V.Q.', amount: 1.65 }] },
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 27.02, taxes: [{ label: 'T.P.S.', amount: 1.18 }, { label: 'T.V.Q.', amount: 2.34 }] },
  { carrier: 'Canpar',        destination_province: 'QC', destination_country: 'CA', total: 25.55, taxes: [{ label: 'T.P.S.', amount: 1.11 }, { label: 'T.V.Q.', amount: 2.22 }] },
  { carrier: 'NationEx',      destination_province: 'QC', destination_country: 'CA', total: 27.36, taxes: [{ label: 'T.P.S.', amount: 1.19 }, { label: 'T.V.Q.', amount: 2.37 }] },
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 35.33, taxes: [] }, // sans taxe (le transporteur n'a pas chargé)
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 17.90, taxes: [{ label: 'T.P.S.', amount: 0.78 }, { label: 'T.V.Q.', amount: 1.55 }] },
  { carrier: 'UPS',           destination_province: 'ME', destination_country: 'US', total: 35.42, taxes: [] }, // export É-U
]

test('facture 250259 — 3 groupes, codes corrects, total réconcilié à 187,60', () => {
  const r = buildTransportInvoice(SAMPLE_250259)

  assert.equal(r.items.length, 3, 'Québec + Québec sans-taxe + export')

  const qc = r.items.find(i => i.tax_code_name === 'TPS/TVQ QC - 9,975')
  assert.ok(qc, 'ligne Québec présente')
  assert.equal(qc.total, 101.63, 'HT des 5 envois Québec taxables')

  const detaxe = r.items.find(i => i.tax_code_name === 'Détaxé')
  assert.ok(detaxe, 'ligne export détaxée présente')
  assert.equal(detaxe.total, 35.42)
  assert.ok(detaxe.description.includes('É.-U.'), 'export libellé par pays')

  const sansTaxe = r.items.find(i => i.tax_code_name === 'Hors champ')
  assert.ok(sansTaxe, 'ligne sans taxe présente → code Hors champ')
  assert.equal(sansTaxe.total, 35.33)
  assert.ok(sansTaxe.description.includes('sans taxe'))
  assert.ok(sansTaxe.description.includes('Québec'), 'sans-taxe libellé par province')

  assert.equal(r.tps, 5.09)
  assert.equal(r.tvq, 10.13)
  assert.equal(r.other_taxes, 0)
  assert.equal(r.subtotal, 172.38)
  assert.equal(r.total, 187.60, 'doit boucler au montant dû')
})

// Données réelles de la facture 250715 : QC (3 envois), NB (TVH 15 %), ON (TVH 13 %),
// BC (TPS + TVP non récupérable), BC sans taxe, export É-U, et un CRÉDIT UPS (retour
// depuis les É-U, -35,42 $) sur la dernière page. Montant total dû : 267,85 $.
const SAMPLE_250715 = [
  { carrier: 'Canada Post',   destination_province: 'QC', destination_country: 'CA', total: 24.68,  taxes: [{ label: 'TPS', amount: 1.07 }, { label: 'TVQ', amount: 2.14 }] },
  { carrier: 'Purolator',     destination_province: 'NB', destination_country: 'CA', total: 19.45,  taxes: [{ label: 'TVH', amount: 2.54 }] },
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 21.79,  taxes: [{ label: 'TPS', amount: 0.95 }, { label: 'TVQ', amount: 1.89 }] },
  { carrier: 'Canpar Express', destination_province: 'BC', destination_country: 'CA', total: 45.53, taxes: [{ label: 'TPS', amount: 2.03 }, { label: 'TVP', amount: 2.85 }] },
  { carrier: 'Canpar Express', destination_province: 'BC', destination_country: 'CA', total: 30.25, taxes: [] },
  { carrier: 'Canpar Express', destination_province: 'QC', destination_country: 'CA', total: 27.09, taxes: [{ label: 'TPS', amount: 1.18 }, { label: 'TVQ', amount: 2.35 }] },
  { carrier: 'FedEx',         destination_province: null, destination_country: 'US', total: 109.33, taxes: [] },
  { carrier: 'NationEx',      destination_province: 'ON', destination_country: 'CA', total: 25.15,  taxes: [{ label: 'TVH', amount: 2.89 }] },
  { carrier: 'UPS',           destination_province: 'ME', destination_country: 'US', total: -35.42, taxes: [] }, // crédit retour
]

test('facture 250715 — lignes par province, TVH NB≠ON, crédit déduit, boucle à 267,85', () => {
  const r = buildTransportInvoice(SAMPLE_250715)

  const qc = r.items.find(i => i.tax_code_name === 'TPS/TVQ QC - 9,975')
  assert.equal(qc.total, 63.98, 'HT des 3 envois Québec')

  // TVH : une ligne PAR province, chacune avec SON code QB (les taux diffèrent).
  const nb = r.items.find(i => i.tax_code_name === 'TVH N.-B. 2016')
  assert.ok(nb, 'ligne Nouveau-Brunswick avec son code TVH')
  assert.equal(nb.total, 16.91)
  const on = r.items.find(i => i.tax_code_name === 'TVH ON')
  assert.ok(on, 'ligne Ontario avec son code TVH')
  assert.equal(on.total, 22.26)

  const bcTps = r.items.find(i => i.tax_code_name === 'TPS')
  assert.equal(bcTps.total, 40.65, 'HT de l\'envoi BC taxé (TPS seule récupérable)')
  assert.ok(bcTps.description.includes('Colombie-Britannique'))

  const bcSansTaxe = r.items.find(i => i.tax_code_name === 'Hors champ')
  assert.equal(bcSansTaxe.total, 30.25)

  // Export É-U : l'envoi FedEx (109,33) NET du crédit UPS (-35,42) = 73,91.
  const exportUs = r.items.find(i => i.tax_code_name === 'Détaxé')
  assert.equal(exportUs.total, 73.91, 'crédit retour déduit du groupe export')

  const pst = r.items.find(i => i.description.includes('non récupérable'))
  assert.equal(pst.total, 2.85, 'TVP BC repliée dans la dépense')
  assert.ok(pst.description.includes('Colombie-Britannique'))
  assert.equal(pst.tax_code_name, 'Hors champ', '0 % explicite — null hériterait du code global, __none__ est refusé par QB (6000)')

  assert.equal(r.items.length, 7)
  assert.equal(r.tps, 5.23)
  assert.equal(r.tvq, 6.38)
  assert.equal(r.other_taxes, 5.43, 'TVH NB 2,54 + TVH ON 2,89')
  assert.equal(r.subtotal, 250.81)
  assert.equal(r.total, 267.85, 'doit boucler au montant total dû de la facture')
})

test('taxe provinciale non récupérable (PST) — repliée dans la dépense, TPS seule réclamée', () => {
  // Envoi vers une province PST : GST récupérable, PST non récupérable.
  const r = buildTransportInvoice([
    { carrier: 'X', destination_province: 'BC', destination_country: 'CA', total: 112, taxes: [{ label: 'GST', amount: 5 }, { label: 'PST', amount: 7 }] },
  ])
  // HT = 112 - 5 - 7 = 100. La PST (7) devient une ligne de dépense sans code.
  const tps = r.items.find(i => i.tax_code_name === 'TPS')
  assert.ok(tps, 'ligne TPS récupérable')
  assert.equal(tps.total, 100)
  const pst = r.items.find(i => i.description.includes('non récupérable'))
  assert.ok(pst, 'ligne PST non récupérable')
  assert.equal(pst.total, 7)
  assert.equal(pst.tax_code_name, 'Hors champ', '0 % — QB exige un code sur chaque ligne')

  assert.equal(r.tps, 5, 'seule la TPS est réclamée')
  assert.equal(r.tvq, 0)
  assert.equal(r.subtotal, 107, 'HT 100 + PST 7 repliée dans la dépense')
  assert.equal(r.total, 112, 'réconcilie : 107 + 5 (TPS)')
})

test('TVH d\'une province inconnue → pas de code (à confirmer), jamais de fusion aveugle', () => {
  const r = buildTransportInvoice([
    { carrier: 'X', destination_province: null, destination_country: 'CA', total: 113, taxes: [{ label: 'TVH', amount: 13 }] },
  ])
  const hst = r.items.find(i => i.description.includes('TVH'))
  assert.equal(hst.tax_code_name, null, 'code laissé à confirmer')
  assert.equal(hst.total, 100)
  assert.equal(r.other_taxes, 13)
  assert.equal(r.total, 113)
})

test('deux provinces TVH ne fusionnent jamais sur une même ligne', () => {
  const r = buildTransportInvoice([
    { carrier: 'A', destination_province: 'NS', destination_country: 'CA', total: 114, taxes: [{ label: 'TVH', amount: 14 }] },
    { carrier: 'B', destination_province: 'PE', destination_country: 'CA', total: 115, taxes: [{ label: 'TVH', amount: 15 }] },
  ])
  assert.equal(r.items.length, 2)
  assert.ok(r.items.find(i => i.tax_code_name === 'TVH N.S.'))
  assert.ok(r.items.find(i => i.tax_code_name === 'TVH Î.-P.-É. 2016'))
  assert.equal(r.total, 229)
})

test('aucune expédition → tout à zéro, aucune ligne', () => {
  const r = buildTransportInvoice([])
  assert.deepEqual(r.items, [])
  assert.equal(r.total, 0)
})
