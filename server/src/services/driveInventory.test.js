import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeFrequency, matchAccountingTerms, classify, kindOfMime, ownerOf, KNOWN_SYNCED_PATTERNS,
  findHeaderRow, findSections, classifyTabNature, classifyTab, syncedTabInfo, deriveItemStatus,
} from './driveInventory.js'

const NOW = new Date('2026-08-09T12:00:00Z')
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString()

test('computeFrequency — fichier édité tous les jours depuis un an', () => {
  const r = computeFrequency({ createdTime: daysAgo(365), modifiedTime: daysAgo(0), version: 3651 }, NOW)
  assert.equal(r.frequency, 'quotidienne')
  assert.equal(r.daysSinceModified, 0)
  assert.ok(r.editsPerMonth > 250)
})

test('computeFrequency — quelques retouches par mois = mensuelle', () => {
  const r = computeFrequency({ createdTime: daysAgo(300), modifiedTime: daysAgo(20), version: 21 }, NOW)
  assert.equal(r.frequency, 'mensuelle')
})

test('computeFrequency — plus touché depuis plus d\'un an = inactive, même très édité avant', () => {
  const r = computeFrequency({ createdTime: daysAgo(1000), modifiedTime: daysAgo(400), version: 5000 }, NOW)
  assert.equal(r.frequency, 'inactive')
  assert.equal(r.daysSinceModified, 400)
})

test('computeFrequency — sans date de modification', () => {
  const r = computeFrequency({ createdTime: null, modifiedTime: null, version: null }, NOW)
  assert.equal(r.frequency, 'inconnue')
  assert.equal(r.editsPerMonth, 0)
})

test('matchAccountingTerms — le dossier parent compte autant que le nom', () => {
  assert.deepEqual(matchAccountingTerms('Notes de rencontre', '01 Comptabilité'), ['compta', 'comptab'])
  assert.deepEqual(matchAccountingTerms('Photos du party', 'Social'), [])
  assert.ok(matchAccountingTerms('Twilio_Suivi.xlsx', 'Twilio').includes('suivi'))
})

test('classify — un fichier du registre est « déjà synchronisé »', () => {
  const registry = { files: new Map([['abc', 'Sync TRX_Orisha']]), folders: new Map() }
  const r = classify({ id: 'abc', name: 'TRX_Orisha.xlsx', modifiedTime: daysAgo(1), createdTime: daysAgo(400), version: 900 },
    { registry, folderName: null })
  assert.equal(r.status, 'synced')
  assert.equal(r.syncTarget, 'Sync TRX_Orisha')
})

test('classify — un fichier d\'un dossier synchronisé hérite du statut', () => {
  const registry = { files: new Map(), folders: new Map([['fold1', 'Déboursés de pièces']]) }
  const r = classify({ id: 'x', name: 'Peu importe', parents: ['fold1'], modifiedTime: daysAgo(2), createdTime: daysAgo(50), version: 5 },
    { registry, folderName: null })
  assert.equal(r.status, 'synced')
})

test('classify — contenu déjà rapatrié, reconnu au nom', () => {
  const registry = { files: new Map(), folders: new Map() }
  const r = classify({ id: 'y', name: 'Sommaire_Statut fiscal des taxes', modifiedTime: daysAgo(11), createdTime: daysAgo(300), version: 800 },
    { registry, folderName: 'TPS/TVQ' })
  assert.equal(r.status, 'synced')
  assert.match(r.syncTarget, /Statuts fiscaux/)
})

test('classify — candidat quand le nom parle comptabilité et que le fichier vit', () => {
  const registry = { files: new Map(), folders: new Map() }
  const r = classify({ id: 'z', name: '2026_Immobilisations.xlsx', modifiedTime: daysAgo(4), createdTime: daysAgo(200), version: 120 },
    { registry, folderName: 'G_Immobilisations' })
  assert.equal(r.status, 'candidate')
  assert.ok(r.terms.includes('immobilis'))
})

test('classify — à ignorer : rien de comptable, ou dormant depuis plus d\'un an', () => {
  const registry = { files: new Map(), folders: new Map() }
  const neutre = classify({ id: 'a', name: 'Photos party de Noël', modifiedTime: daysAgo(3), createdTime: daysAgo(100), version: 4 },
    { registry, folderName: 'Social' })
  assert.equal(neutre.status, 'ignore')
  const dormant = classify({ id: 'b', name: 'Budget 2019', modifiedTime: daysAgo(900), createdTime: daysAgo(2000), version: 300 },
    { registry, folderName: 'Comptabilité' })
  assert.equal(dormant.status, 'ignore')
  assert.match(dormant.reason, /plus d'un an/)
})

test('ownerOf — Drive partagé : pas de propriétaire au sens de l\'API, on nomme le Drive', () => {
  const shared = new Map([['d1', 'Orisha - Drive partagé']])
  assert.deepEqual(ownerOf({ driveId: 'd1' }, shared), { email: null, name: 'Drive partagé — Orisha - Drive partagé' })
  assert.deepEqual(
    ownerOf({ owners: [{ emailAddress: 'michel@orisha.io', displayName: 'Michel Lambert' }] }, shared),
    { email: 'michel@orisha.io', name: 'Michel Lambert' },
  )
  assert.deepEqual(ownerOf({}, shared), { email: null, name: null })
})

test('kindOfMime — classeurs et documents', () => {
  assert.equal(kindOfMime('application/vnd.google-apps.spreadsheet'), 'spreadsheet')
  assert.equal(kindOfMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'spreadsheet')
  assert.equal(kindOfMime('application/vnd.google-apps.document'), 'document')
  assert.equal(kindOfMime('image/png'), 'other')
})

test('KNOWN_SYNCED_PATTERNS — les feuilles de temps mensuelles sont reconnues quel que soit le mois', () => {
  const hit = n => KNOWN_SYNCED_PATTERNS.some(([re]) => re.test(n))
  assert.ok(hit('feuille_de_temps_7_2026.xlsx'))
  assert.ok(hit('feuille_de_temps_12_2025.xlsx'))
  assert.ok(hit('Pièces_Déboursés_Juillet26'))
  assert.ok(!hit('feuille de temps de Marc'))
})

// ── Granularité onglet ───────────────────────────────────────────────────────

const CTB = '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ'
const REGISTRY_TABS = [
  { file: CTB, tab: 'Sommaire', partial: true, label: 'Deux sections sur trois' },
  { file: CTB, tab: 'Pmt_Suivi', label: 'Paiements émis' },
  { file: 'trx', tab: '*', label: 'Rapprochement bancaire' },
]

test('findHeaderRow — la ligne de titre du bloc n\'est pas l\'en-tête, celle des colonnes l\'est', () => {
  const rows = [
    ['FACTURES MANQUANTES (À DEMANDER)', '', '', ''],
    ['Fournisseur', '$', 'Compte', 'Date'],
    ['Anthropic', '179.52', 'Master', '46225'],
  ]
  assert.equal(findHeaderRow(rows), 1)
  // Sans ligne de données en dessous, ce n'est pas un tableau.
  assert.equal(findHeaderRow([['Fournisseur', '$', 'Compte', 'Date']]), -1)
})

test('findSections — les blocs empilés d\'un onglet sont listés', () => {
  const rows = [
    ['FACTURES MANQUANTES (À DEMANDER)'],
    ['Fournisseur', '$', 'Compte'],
    ['Anthropic', '179.52', 'Master'],
    ['PROGRAMMATION DES FACTURES À PAYER'],
    ['Fournisseur', '$', 'Dû le'],
  ]
  assert.deepEqual(findSections(rows), ['FACTURES MANQUANTES (À DEMANDER)', 'PROGRAMMATION DES FACTURES À PAYER'])
  // Une phrase normale en colonne A n'est pas un titre de section.
  assert.deepEqual(findSections([['Il arrive que PA fasse un paiement personnel']]), [])
})

test('classifyTabNature — tableau, prose, grille et vide se distinguent', () => {
  const donnees = [['Fournisseur', 'Plan', 'Devise', 'Montant'], ...Array.from({ length: 5 }, (_, i) => [`F${i}`, 'Pro', 'CAD', '10'])]
  assert.equal(classifyTabNature({ rows: donnees }), 'donnees')

  const prose = Array.from({ length: 5 }, (_, i) => [`Phrase très longue numéro ${i} qui explique une procédure comptable interne en détail.`])
  assert.equal(classifyTabNature({ rows: prose }), 'procedure')

  assert.equal(classifyTabNature({ rows: [['x']] }), 'vide')
  assert.equal(classifyTabNature({ rows: [['USD', 'Taux'], ['249.9', '1.47']], formulaRatio: 0.6 }), 'calculatrice')
})

test('classifyTab — le registre l\'emporte, et « Sommaire » reste partiellement repris', () => {
  const partiel = classifyTab({ tab_name: 'Sommaire', nature: 'donnees', rows_count: 16, header: [] },
    { registryTabs: REGISTRY_TABS, fileId: CTB })
  assert.equal(partiel.status, 'partial')
  assert.equal(partiel.syncTarget, 'Deux sections sur trois')

  const couvert = classifyTab({ tab_name: 'Pmt_Suivi', nature: 'donnees', rows_count: 574, header: [] },
    { registryTabs: REGISTRY_TABS, fileId: CTB })
  assert.equal(couvert.status, 'synced')

  // Onglet du même classeur absent du registre → à trancher, pas « déjà fait ».
  const ouvert = classifyTab({ tab_name: 'Abonn.', nature: 'donnees', rows_count: 36, header: ['Nom du fournisseur', 'Plan'] },
    { registryTabs: REGISTRY_TABS, fileId: CTB })
  assert.equal(ouvert.status, 'candidate')
  assert.match(ouvert.reason, /36 lignes/)
})

test('classifyTab — un fichier lu en entier couvre tous ses onglets, sauf s\'il est piloté au détail', () => {
  // Feuille de temps mensuelle : le fichier entier est importé, ses onglets
  // « Prénom Nom » ne doivent pas revenir en suggestion.
  const couvert = classifyTab(
    { tab_name: 'Pierre-Alexandre Papillon', nature: 'donnees', rows_count: 30, header: ['Dates', 'Heures RSDE'] },
    { registryTabs: REGISTRY_TABS, fileId: 'feuille-de-temps', fileSync: 'Feuilles de temps R&D' },
  )
  assert.equal(couvert.status, 'synced')
  assert.equal(couvert.syncTarget, 'Feuilles de temps R&D')

  // CTB - Suivi figure au registre PAR ONGLET : la couverture du fichier ne
  // vaut pas pour un onglet qui n'y est pas listé.
  const ouvert = classifyTab(
    { tab_name: 'Abonn.', nature: 'donnees', rows_count: 36, header: ['Nom du fournisseur'] },
    { registryTabs: REGISTRY_TABS, fileId: CTB, fileSync: 'CTB - Suivi : programmation' },
  )
  assert.equal(ouvert.status, 'candidate')
})

test('syncedTabInfo — le joker couvre tous les onglets du fichier visé, et lui seul', () => {
  assert.equal(syncedTabInfo(REGISTRY_TABS, 'trx', 'BNC CAD').status, 'synced')
  assert.equal(syncedTabInfo(REGISTRY_TABS, 'trx', "N'importe quoi").status, 'synced')
  assert.equal(syncedTabInfo(REGISTRY_TABS, 'autre-fichier', 'Pmt_Suivi'), null)
})

test('deriveItemStatus — 2 onglets couverts sur 12 ne font pas un fichier synchronisé', () => {
  const ctbTabs = [
    { status: 'partial' }, { status: 'synced' },
    ...Array.from({ length: 7 }, () => ({ status: 'candidate' })),
    ...Array.from({ length: 3 }, () => ({ status: 'ignore' })),
  ]
  assert.equal(deriveItemStatus(ctbTabs, 'synced'), 'partial')
  assert.equal(deriveItemStatus([{ status: 'synced' }, { status: 'synced' }], 'synced'), 'synced')
  assert.equal(deriveItemStatus([{ status: 'candidate' }], 'candidate'), 'candidate')
  // Sans onglet lu, on garde le statut déduit des métadonnées.
  assert.equal(deriveItemStatus([], 'candidate'), 'candidate')
})
