import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPrompt, fallbackJudgement, normalizeJudgement, statusAfterJudgement, ERP_MODULES,
} from './driveInventoryAnalysis.js'

const tab = (over = {}) => ({
  tab_name: 'Abonn.', nature: 'donnees', rows_count: 36, status: 'candidate',
  header: ['Nom du fournisseur', 'Plan/Forfait', 'CAD/USD', 'Fréquence'],
  sample: [['Adobe', 'Photographie', 'CAD', 'Mensuel']], sections: [], ...over,
})

test('buildPrompt — l\'état « déjà repris » est dit au modèle, sinon il rejuge tout l\'onglet', () => {
  const item = { name: 'CTB - Suivi', parent_folder_name: 'Compta', frequency: 'quotidienne', days_since_modified: 0 }
  const p = buildPrompt(item, [
    tab({ tab_name: 'Pmt_Suivi', status: 'synced', sync_target: 'Paiements émis' }),
    tab({ tab_name: 'Sommaire', status: 'partial', sync_target: 'Deux sections sur trois', sections: ['FACTURES MANQUANTES', 'PROGRAMMATION DES FACTURES À PAYER'] }),
    tab(),
  ])
  assert.match(p, /DÉJÀ REPRIS PAR L'ERP : Paiements émis/)
  assert.match(p, /PARTIELLEMENT REPRIS : Deux sections sur trois/)
  assert.match(p, /juge UNIQUEMENT ce qui n'est pas encore repris/)
  assert.match(p, /Sections du bloc : FACTURES MANQUANTES \/ PROGRAMMATION/)
  assert.match(p, /Nom du fournisseur \| Plan\/Forfait/)
})

test('normalizeJudgement — verdict inconnu rejeté, module inventé ramené à « Aucun module existant »', () => {
  assert.equal(normalizeJudgement({ verdict: 'supprimer' }, tab()), null)
  assert.equal(normalizeJudgement(null, tab()), null)
  const j = normalizeJudgement({ verdict: 'importer', relevance: 95, target_module: 'Module Inventé', suggestion: 'x' }, tab())
  assert.equal(j.target_module, 'Aucun module existant')
  assert.equal(j.relevance, 95)
})

test('normalizeJudgement — un module réel du catalogue passe tel quel, la note est bornée', () => {
  const j = normalizeJudgement({ verdict: 'importer', relevance: 250, target_module: 'Abonnements fournisseurs', suggestion: 'y' }, tab())
  assert.equal(j.target_module, 'Abonnements fournisseurs')
  assert.equal(j.relevance, 100)
  assert.ok(ERP_MODULES.some(([m]) => m === j.target_module))
  // Sans note chiffrée, un « importer » reste haut placé.
  assert.equal(normalizeJudgement({ verdict: 'importer', target_module: null, suggestion: '' }, tab()).relevance, 70)
})

test('statusAfterJudgement — le modèle ne peut pas déclarer un onglet synchronisé', () => {
  assert.equal(statusAfterJudgement('synced', 'importer'), 'synced')
  assert.equal(statusAfterJudgement('partial', 'ignorer'), 'partial')
  // Une procédure écartée par le scan revient dans la course si le modèle la retient.
  assert.equal(statusAfterJudgement('ignore', 'importer'), 'candidate')
  assert.equal(statusAfterJudgement('candidate', 'ignorer'), 'ignore')
  assert.equal(statusAfterJudgement('candidate', 'garder'), 'candidate')
})

test('fallbackJudgement — sans modèle, un tableau reste orienté vers un module plausible', () => {
  const j = fallbackJudgement(tab())
  assert.equal(j.verdict, 'importer')
  assert.equal(j.target_module, 'Abonnements fournisseurs')
  assert.ok(j.relevance > 50)

  const vide = fallbackJudgement(tab({ nature: 'vide', rows_count: 0 }))
  assert.equal(vide.verdict, 'ignorer')
  assert.equal(vide.relevance, 0)

  const proc = fallbackJudgement(tab({ nature: 'procedure', tab_name: 'TRX à linterne', header: [] }))
  assert.equal(proc.verdict, 'garder')
})
