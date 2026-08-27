import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatusLabel, currencyFromRow, typeFromExplanation, parseAnomalyRows, planUpdates,
  resolveProfileForSheetName,
} from './fiscalAnomaliesSheet.js'

// Grille reproduisant l'onglet « Fournisseurs_TPS_TVQ_Anomalies » réel : titre,
// lignes vides, entête, puis les corrections du mentor.
const ROWS = [
  ['ANOMALIES'],
  [],
  ['Date', 'Compte/facture à payer', 'Fournisseur', 'Montant', 'Ce qui a été fait', 'Ce qui aurait dû être fait', 'Commentaires/Explications'],
  ['06/08/2026', 'Venn USD', 'Celonis', '10.59', 'Hors-champ', 'Détaxé',
    "Couvert par l'exemption Business to Business (B2B). Orisha a fourni ses # de TPS et TVQ à Celonis donc détaxé."],
  ['22/07/2026', 'Visa USD', 'Simplex', '28.70', 'Exonéré', 'Détaxé',
    "Probablement couvert par l'exemption Business to Business (B2B)."],
  ['13/07/2026', 'Venn USD', 'Postmark', '15.00', 'Hors-champ', 'Hors-champ',
    "N'est pas considéré comme un B2B (détaxé) donc c'est un hors-champ"],
  ['22/06/2026', 'Mastercard', 'Amazon', '8.50', 'Hors-champ', 'Détaxé', 'Produit alimentaire = Détaxé'],
  ['19/06/2026', 'Mastercard', 'Amazon', '(195.39)', 'Hors-champ', 'Taxable',
    'Un remboursement pour une facture sur laquelle il y avait de la TPS et TVQ doit aussi considérer les taxes.'],
  ['01/06/2026', 'Mastercard', 'Fedex', '479.85', 'Exonéré', 'Détaxé',
    'Tout service de transport de marchandises dont le point origine est au Canada et la destination finale est à extérieur du Canada est automatiquement détaxé.'],
  ['25/05/2026', 'Visa USD', 'Desjardins', '71.06', 'Hors champ (frais de conversion)', 'Exonéré',
    'Les opérations de change et la conversion de devises sont classifiées comme des services financiers.'],
  [],
  [],
]

test('parseStatusLabel reconnaît les variantes écrites à la main', () => {
  assert.equal(parseStatusLabel('Détaxé'), 'detaxe')
  assert.equal(parseStatusLabel('Hors-champ'), 'hors_champ')
  assert.equal(parseStatusLabel('Hors champ (frais de conversion)'), 'hors_champ')
  assert.equal(parseStatusLabel('Exonéré'), 'exonere')
  assert.equal(parseStatusLabel('Taxable'), 'taxable')
  assert.equal(parseStatusLabel(''), null)
  assert.equal(parseStatusLabel('à vérifier'), null)
})

test('currencyFromRow lit la devise du compte ou du montant', () => {
  assert.equal(currencyFromRow('Visa USD', '28.70'), 'USD')
  assert.equal(currencyFromRow('Mastercard', '8.50'), 'CAD')
  assert.equal(currencyFromRow('Facture à payer', '40 USD'), 'USD')
})

test('typeFromExplanation ne retient un type que si son statut concorde', () => {
  assert.equal(typeFromExplanation("Couvert par l'exemption Business to Business (B2B)", 'detaxe'), 'achat_num_inscrit_b2b_exempte')
  assert.equal(typeFromExplanation('Le café est un produit alimentaire de base', 'detaxe'), 'produits_alimentaires_base')
  assert.equal(typeFromExplanation('Les opérations de change sont des services financiers', 'exonere'), 'frais_conversion')
  // Même texte, mais le mentor a corrigé vers un AUTRE statut → on n'invente pas.
  assert.equal(typeFromExplanation("Exemption Business to Business (B2B)", 'hors_champ'), null)
  assert.equal(typeFromExplanation('Aucun indice utile ici', 'detaxe'), null)
})

test('parseAnomalyRows trouve l’entête et lit les colonnes A→G', () => {
  const rows = parseAnomalyRows(ROWS)
  assert.equal(rows.length, 7)
  const celonis = rows[0]
  assert.equal(celonis.vendorName, 'Celonis')
  assert.equal(celonis.currency, 'USD')
  assert.equal(celonis.usedStatus, 'hors_champ')
  assert.equal(celonis.correctStatus, 'detaxe')
  assert.equal(celonis.rowKey, '06/08/2026|celonis|10.59')
})

test('parseAnomalyRows ignore les lignes sans fournisseur ou sans correction', () => {
  assert.deepEqual(parseAnomalyRows([['Date', 'Compte', 'Fournisseur', 'Montant', 'Fait', 'Aurait dû', 'Comm.'],
    [null, null, '', '', '', '', ''], ['01/01/2026', 'Visa CAD', 'Machin', '10', 'Exonéré', '', 'sans conclusion']]), [])
  assert.deepEqual(parseAnomalyRows([['rien ici']]), [])
})

test('planUpdates : correction simple → code de taxe + type de transaction', () => {
  const plans = planUpdates(parseAnomalyRows(ROWS))
  const celonis = plans.find(p => p.vendorName === 'Celonis')
  assert.equal(celonis.status, 'detaxe')
  assert.equal(celonis.codeName, 'Détaxé')
  assert.equal(celonis.type, 'achat_num_inscrit_b2b_exempte')

  const fedex = plans.find(p => p.vendorName === 'Fedex')
  assert.equal(fedex.type, 'transport_export')

  // Statut confirmé (rien n'a été mal fait) : la ligne vaut quand même défaut.
  const postmark = plans.find(p => p.vendorName === 'Postmark')
  assert.equal(postmark.codeName, 'Hors champ')
})

test('planUpdates : lignes contradictoires du même fournisseur = conflit, rien appliqué', () => {
  const amazon = planUpdates(parseAnomalyRows(ROWS)).find(p => p.vendorName === 'Amazon')
  assert.deepEqual(amazon.conflict, ['detaxe', 'taxable'])
  assert.equal(amazon.status, null)
})

test('planUpdates : une correction « Taxable » seule reste ambiguë', () => {
  const rows = parseAnomalyRows([
    ['Date', 'Compte', 'Fournisseur', 'Montant', 'Fait', 'Aurait dû', 'Comm.'],
    ['19/06/2026', 'Mastercard', 'Bureau en gros', '50', 'Hors-champ', 'Taxable', 'des taxes étaient facturées'],
  ])
  const plan = planUpdates(rows)[0]
  assert.equal(plan.ambiguous, true)
  assert.equal(plan.codeName, undefined)
})

test('planUpdates sépare les devises du même fournisseur', () => {
  const rows = parseAnomalyRows([
    ['Date', 'Compte', 'Fournisseur', 'Montant', 'Fait', 'Aurait dû', 'Comm.'],
    ['25/05/2026', 'Visa CAD', 'Desjardins', '1313.73', 'Exonéré', 'Hors-champ', 'éteindre une dette (solde de carte)'],
    ['25/05/2026', 'Visa USD', 'Desjardins', '71.06', 'Hors-champ', 'Exonéré', 'conversion de devises = services financiers'],
  ])
  const plans = planUpdates(rows)
  assert.equal(plans.length, 2)
  assert.equal(plans.find(p => p.currency === 'CAD').type, 'remboursement_dette')
  assert.equal(plans.find(p => p.currency === 'USD').type, 'frais_conversion')
})

test('resolveProfileForSheetName : repli par préfixe seulement s’il est unique', () => {
  const profiles = [
    { id: '1', name: 'Simplex Wireless' },
    { id: '2', name: 'Postmark (ActiveCampaign)' },
    { id: '3', name: 'Amazon.ca' },
    { id: '4', name: 'Amazon Web Services' },
  ]
  assert.equal(resolveProfileForSheetName('Simplex', profiles).profile.id, '1')
  assert.equal(resolveProfileForSheetName('Postmark', profiles).matchedBy, 'prefixe')
  assert.equal(resolveProfileForSheetName('Amazon', profiles).profile, null)
  assert.deepEqual(resolveProfileForSheetName('Amazon', profiles).ambiguousNames, ['Amazon.ca', 'Amazon Web Services'])
  assert.equal(resolveProfileForSheetName('Celonis', profiles).profile, null)
  // Trop court pour un préfixe : pas de rattrapage hasardeux.
  assert.equal(resolveProfileForSheetName('Sim', profiles).profile, null)
})
