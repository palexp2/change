// Tests du résolveur de détection fiscale (services/fiscalDetection.js).
// `history` et `profile` sont injectés partout → aucune écriture DB, lecture seule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  taxSignature, codeMatchesAmounts, typeMatchesAmounts,
  recommendedCodeForType, resolveFiscalDetection,
} from './fiscalDetection.js'

// ── taxSignature ──────────────────────────────────────────────────────────────

test('taxSignature : TPS+TVQ aux taux légaux', () => {
  const s = taxSignature({ subtotal: 100, tps: 5, tvq: 9.98 })
  assert.equal(s.kind, 'tps_tvq')
  assert.equal(s.tpsRateOk, true)
  assert.equal(s.tvqRateOk, true)
})

test('taxSignature : aucune taxe / autres taxes', () => {
  assert.equal(taxSignature({ subtotal: 50 }).kind, 'aucune')
  assert.equal(taxSignature({ subtotal: 50, other_taxes: 6.5 }).kind, 'autre')
})

test('taxSignature : taux incohérent signalé (extraction bancale)', () => {
  // TPS à 2,5 % du sous-total (facture à lignes mixtes ou taxes incluses).
  const s = taxSignature({ subtotal: 100, tps: 2.5 })
  assert.equal(s.kind, 'tps')
  assert.equal(s.tpsRateOk, false)
})

// ── Compatibilité codes / types ↔ montants ───────────────────────────────────

test('codeMatchesAmounts : codes 0 % incompatibles avec des taxes facturées', () => {
  const taxed = taxSignature({ subtotal: 100, tps: 5, tvq: 9.98 })
  assert.equal(codeMatchesAmounts('Détaxé', taxed), false)
  assert.equal(codeMatchesAmounts('Hors champ', taxed), false)
  assert.equal(codeMatchesAmounts('TPS/TVQ QC - 9,975', taxed), true)
})

test('codeMatchesAmounts : code taxable incompatible avec 0 $ de taxe', () => {
  const none = taxSignature({ subtotal: 100 })
  assert.equal(codeMatchesAmounts('TPS/TVQ QC - 9,975', none), false)
  assert.equal(codeMatchesAmounts('Exonéré', none), true)
})

test('codeMatchesAmounts : TVH dans autres taxes contredit un code 0 %', () => {
  const hst = taxSignature({ subtotal: 100, other_taxes: 13 })
  assert.equal(codeMatchesAmounts('Hors champ', hst), false)
})

test('codeMatchesAmounts : code inconnu du référentiel → pas d\'opinion', () => {
  assert.equal(codeMatchesAmounts('TPS/TVQ kilométrage', taxSignature({ subtotal: 100 })), null)
})

test('typeMatchesAmounts : achat local taxable couvre TPS seule comme TPS+TVQ', () => {
  assert.equal(typeMatchesAmounts('achat_local_taxable', taxSignature({ subtotal: 100, tps: 5 })), true)
  assert.equal(typeMatchesAmounts('achat_local_taxable', taxSignature({ subtotal: 100, tps: 5, tvq: 9.98 })), true)
  assert.equal(typeMatchesAmounts('achat_local_taxable', taxSignature({ subtotal: 100 })), false)
})

test('recommendedCodeForType : code adapté aux montants, pas le premier de la liste', () => {
  // Achat local taxable + TPS seule → « TPS », pas « TPS/TVQ QC - 9,975 ».
  assert.equal(recommendedCodeForType('achat_local_taxable', taxSignature({ subtotal: 100, tps: 5 })), 'TPS')
  assert.equal(recommendedCodeForType('achat_local_taxable', taxSignature({ subtotal: 100, tps: 5, tvq: 9.98 })), 'TPS/TVQ QC - 9,975')
  // Sans signature compatible, on retombe sur le code recommandé générique.
  assert.equal(recommendedCodeForType('produits_alimentaires_base', taxSignature({ subtotal: 100, tps: 5 })), 'Détaxé')
})

// ── resolveFiscalDetection ────────────────────────────────────────────────────

test('profil fournisseur compatible = signal gagnant, confiance haute', () => {
  const d = resolveFiscalDetection(
    { company: 'Energitech', currency: 'CAD', subtotal: 100, tps: 5, tvq: 9.98 },
    { profile: { default_transaction_type: 'achat_local_taxable' }, history: null },
  )
  assert.equal(d.transaction_type, 'achat_local_taxable')
  assert.equal(d.source, 'profil')
  assert.equal(d.confidence, 'haute')
  assert.equal(d.tax_code_name, 'TPS/TVQ QC - 9,975')
  assert.equal(d.conflicts.length, 0)
})

test('profil incompatible avec les montants → écarté AVEC conflit, signal suivant', () => {
  // Profil appris « Détaxé » (exemption B2B) mais CETTE facture porte TPS+TVQ :
  // le défaut du profil ne doit pas se propager silencieusement (bug Simplex inversé).
  const d = resolveFiscalDetection(
    { company: 'Simplex Wireless', currency: 'CAD', subtotal: 100, tps: 5, tvq: 9.98 },
    { profile: { default_transaction_type: 'achat_num_inscrit_b2b_exempte' }, history: null },
  )
  assert.notEqual(d.transaction_type, 'achat_num_inscrit_b2b_exempte')
  assert.equal(d.conflicts.length, 1)
  assert.equal(d.conflicts[0].source, 'profil')
  assert.match(d.conflicts[0].message, /TPS/)
  assert.equal(d.confidence, 'basse')
})

test('historique majoritaire compatible gagne quand pas de profil', () => {
  const d = resolveFiscalDetection(
    { company: 'Axxess International', currency: 'CAD', subtotal: 100 },
    { profile: null, history: { type: 'courtage_export', count: 5, total: 6 } },
  )
  assert.equal(d.transaction_type, 'courtage_export')
  assert.equal(d.source, 'historique')
  assert.equal(d.confidence, 'haute') // ≥3 publications + heuristique Axxess concordante
  assert.equal(d.tax_code_name, 'Détaxé')
})

test('classification IA du document utilisée quand profil et historique absents', () => {
  const d = resolveFiscalDetection(
    { company: 'Acme Parts Co', currency: 'USD', subtotal: 200, extracted_transaction_type: 'achat_etranger_bien_etranger' },
    { profile: null, history: null },
  )
  assert.equal(d.transaction_type, 'achat_etranger_bien_etranger')
  assert.equal(d.source, 'document')
  assert.equal(d.confidence, 'moyenne')
  assert.equal(d.tax_code_name, 'Hors champ')
})

test('classification IA invalide (clé inconnue) ignorée sans casser', () => {
  const d = resolveFiscalDetection(
    { company: 'Acme Parts Co', currency: 'USD', subtotal: 200, extracted_transaction_type: 'type_inexistant' },
    { profile: null, history: null },
  )
  assert.equal(d.transaction_type, null)
})

test('deux signaux concordants → confiance haute', () => {
  const d = resolveFiscalDetection(
    { company: 'Fournisseur Local Inc', currency: 'CAD', subtotal: 100, tps: 5, tvq: 9.98, extracted_transaction_type: 'achat_local_taxable' },
    { profile: null, history: null },
  )
  // document + regles (fournisseur CAD taxé) concordent sur achat_local_taxable.
  assert.equal(d.transaction_type, 'achat_local_taxable')
  assert.deepEqual([...d.agreements].sort(), ['document', 'regles'])
  assert.equal(d.confidence, 'haute')
})

test('heuristique seule = confiance basse', () => {
  const d = resolveFiscalDetection(
    { company: 'Quincaillerie Untel', currency: 'CAD', subtotal: 100, tps: 5, tvq: 9.98 },
    { profile: null, history: null },
  )
  assert.equal(d.transaction_type, 'achat_local_taxable')
  assert.equal(d.source, 'regles')
  assert.equal(d.confidence, 'basse')
})

test('aucun signal compatible → null, conflits exposés', () => {
  // Profil « achat local taxable » mais document sans aucune taxe : rien de fiable.
  const d = resolveFiscalDetection(
    { company: 'Mystère Corp', currency: 'USD', subtotal: 80 },
    { profile: { default_transaction_type: 'achat_local_taxable' }, history: null },
  )
  assert.equal(d.transaction_type, null)
  assert.equal(d.confidence, null)
  assert.equal(d.conflicts.length, 1)
  assert.match(d.conflicts[0].message, /aucune taxe/)
})

test('alerte de taux quand la TPS extraite dévie du 5 %', () => {
  const d = resolveFiscalDetection(
    { company: 'Amazon.ca', currency: 'CAD', subtotal: 100, tps: 2.1, tvq: 4.2 },
    { profile: null, history: null },
  )
  assert.equal(d.warnings.length, 2)
  assert.match(d.warnings[0], /TPS/)
  assert.match(d.warnings[1], /TVQ/)
})
