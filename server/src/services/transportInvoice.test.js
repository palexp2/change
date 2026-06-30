// Reconstruction des lignes d'une facture de transport multi-expéditions.
// Le cas de référence est la vraie facture NovoXpress / Groupe Alliances et Privilèges
// 250259 (7 pages) : 5 envois Québec (TPS/TVQ), 1 envoi Québec sans taxe, 1 export É-U.
// L'invariant fiscal doit boucler exactement au total dû de 187,60 $.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTransportInvoice, classifyTax } from './transportInvoice.js'

test('classifyTax reconnaît les libellés malgré la ponctuation', () => {
  assert.equal(classifyTax('T.P.S. (5%) - 784615486RT0001'), 'gst')
  assert.equal(classifyTax('T.V.Q. (9,975%) - 1225170467TQ0001'), 'qst')
  assert.equal(classifyTax('TVH'), 'hst')
  assert.equal(classifyTax('PST (BC)'), 'pst')
  assert.equal(classifyTax('Frais bizarres'), 'other')
})

// Données réelles de la facture 250259 (un envoi par page, taxes telles qu'imprimées).
const SAMPLE = [
  { carrier: 'Postes Canada', destination_province: 'QC', destination_country: 'CA', total: 19.02, taxes: [{ label: 'T.P.S.', amount: 0.83 }, { label: 'T.V.Q.', amount: 1.65 }] },
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 27.02, taxes: [{ label: 'T.P.S.', amount: 1.18 }, { label: 'T.V.Q.', amount: 2.34 }] },
  { carrier: 'Canpar',        destination_province: 'QC', destination_country: 'CA', total: 25.55, taxes: [{ label: 'T.P.S.', amount: 1.11 }, { label: 'T.V.Q.', amount: 2.22 }] },
  { carrier: 'NationEx',      destination_province: 'QC', destination_country: 'CA', total: 27.36, taxes: [{ label: 'T.P.S.', amount: 1.19 }, { label: 'T.V.Q.', amount: 2.37 }] },
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 35.33, taxes: [] }, // sans taxe (le transporteur n'a pas chargé)
  { carrier: 'Purolator',     destination_province: 'QC', destination_country: 'CA', total: 17.90, taxes: [{ label: 'T.P.S.', amount: 0.78 }, { label: 'T.V.Q.', amount: 1.55 }] },
  { carrier: 'UPS',           destination_province: 'ME', destination_country: 'US', total: 35.42, taxes: [] }, // export É-U
]

test('facture 250259 — 3 groupes, codes corrects, total réconcilié à 187,60', () => {
  const r = buildTransportInvoice(SAMPLE)

  assert.equal(r.items.length, 3, 'Québec + sans-taxe + export')

  const qc = r.items.find(i => i.tax_code_name === 'TPS/TVQ QC - 9,975')
  assert.ok(qc, 'ligne Québec présente')
  assert.equal(qc.total, 101.63, 'HT des 5 envois Québec taxables')

  const detaxe = r.items.find(i => i.tax_code_name === 'Détaxé')
  assert.ok(detaxe, 'ligne export détaxée présente')
  assert.equal(detaxe.total, 35.42)

  const sansTaxe = r.items.find(i => i.tax_code_name === 'Hors champ')
  assert.ok(sansTaxe, 'ligne sans taxe présente → code Hors champ')
  assert.equal(sansTaxe.total, 35.33)
  assert.ok(sansTaxe.description.includes('sans taxe'))

  assert.equal(r.tps, 5.09)
  assert.equal(r.tvq, 10.13)
  assert.equal(r.other_taxes, 0)
  assert.equal(r.subtotal, 172.38)
  assert.equal(r.total, 187.60, 'doit boucler au montant dû')
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

  assert.equal(r.tps, 5, 'seule la TPS est réclamée')
  assert.equal(r.tvq, 0)
  assert.equal(r.subtotal, 107, 'HT 100 + PST 7 repliée dans la dépense')
  assert.equal(r.total, 112, 'réconcilie : 107 + 5 (TPS)')
})

test('aucune expédition → tout à zéro, aucune ligne', () => {
  const r = buildTransportInvoice([])
  assert.deepEqual(r.items, [])
  assert.equal(r.total, 0)
})
