// Tests du référentiel de statuts fiscaux (services/fiscalStatus.js).
// Fonctions pures — aucune DB ni appel réseau, rien à nettoyer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listTransactionTypes, getTransactionType,
  validateTaxCodeAgainstType, suggestTransactionType,
} from './fiscalStatus.js'

test('listTransactionTypes : liste non vide, statut + code recommandé exposés', () => {
  const types = listTransactionTypes()
  assert.ok(types.length >= 20, 'au moins 20 types')
  for (const t of types) {
    assert.ok(t.key && t.label, 'key + label requis')
    assert.ok(Array.isArray(t.codes) && t.codes.length, 'au moins un code attendu')
    assert.equal(t.recommendedCode, t.codes[0], 'recommendedCode = premier code')
    assert.ok(['taxable', 'detaxe', 'exonere', 'hors_champ'].includes(t.status))
    assert.ok(t.statusLabel, 'libellé de statut')
  }
})

test('validateTaxCodeAgainstType : code conforme = ok', () => {
  // Café = produits alimentaires de base → Détaxé.
  const r = validateTaxCodeAgainstType('produits_alimentaires_base', 'Détaxé')
  assert.equal(r.ok, true)
  assert.equal(r.statusLabel, 'Détaxé')
  assert.equal(r.recommendedCode, 'Détaxé')
})

test('validateTaxCodeAgainstType : le bug café — Hors champ ≠ Détaxé', () => {
  // Reproduit l'erreur du Sheet : café Amazon publié « Hors champ » au lieu de « Détaxé ».
  const r = validateTaxCodeAgainstType('produits_alimentaires_base', 'Hors champ')
  assert.equal(r.ok, false, 'doit détecter l’écart')
  assert.equal(r.recommendedCode, 'Détaxé')
})

test('validateTaxCodeAgainstType : aucune taxe ne matche jamais un type', () => {
  // Un statut 0 % (Détaxé) exige quand même le code précis, pas « aucune taxe ».
  const r = validateTaxCodeAgainstType('produits_alimentaires_base', null)
  assert.equal(r.ok, false)
})

test('validateTaxCodeAgainstType : repas → code spécifique TPS/TVQ repas', () => {
  assert.equal(validateTaxCodeAgainstType('repas_representation', 'TPS/TVQ repas').ok, true)
  // Le code QC générique n'est PAS conforme pour un repas (récupération 50 %).
  assert.equal(validateTaxCodeAgainstType('repas_representation', 'TPS/TVQ QC - 9,975').ok, false)
})

test('validateTaxCodeAgainstType : achat local taxable accepte plusieurs codes', () => {
  assert.equal(validateTaxCodeAgainstType('achat_local_taxable', 'TPS/TVQ QC - 9,975').ok, true)
  assert.equal(validateTaxCodeAgainstType('achat_local_taxable', 'TPS').ok, true)
})

test('validateTaxCodeAgainstType : type inconnu', () => {
  assert.equal(validateTaxCodeAgainstType('inexistant', 'Détaxé').unknownType, true)
})

test('getTransactionType : clé valide / invalide', () => {
  assert.ok(getTransactionType('loyer'))
  assert.equal(getTransactionType('nope'), null)
  assert.equal(getTransactionType(''), null)
})

test('suggestTransactionType : café Amazon → produits alimentaires de base', () => {
  const s = suggestTransactionType({ company: 'Amazon.com.ca', generalDescription: 'Café en grains pour la cuisine', tps: 0, tvq: 0 })
  assert.equal(s, 'produits_alimentaires_base')
})

test('suggestTransactionType : Google → exemption B2B détaxée', () => {
  assert.equal(suggestTransactionType({ company: 'Google Cloud', tps: 0, tvq: 0 }), 'achat_num_inscrit_b2b_exempte')
})

test('suggestTransactionType : fournisseur numérique avec/sans taxes', () => {
  assert.equal(suggestTransactionType({ company: 'OpenAI OpCo, LLC', tps: 0.65, tvq: 1.3 }), 'achat_num_inscrit_taxe')
  assert.equal(suggestTransactionType({ company: 'OpenAI OpCo, LLC', tps: 0, tvq: 0 }), 'achat_num_inscrit_b2b_exempte')
})

test('suggestTransactionType : fournisseur canadien taxé → achat local', () => {
  assert.equal(suggestTransactionType({ company: 'Energitech', currency: 'CAD', tps: 10.5, tvq: 20.95 }), 'achat_local_taxable')
})

test('suggestTransactionType : étranger sans taxe = trop ambigu → null', () => {
  assert.equal(suggestTransactionType({ company: 'Acme Parts Co', currency: 'USD', tps: 0, tvq: 0 }), null)
})
