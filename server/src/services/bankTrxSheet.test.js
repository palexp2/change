import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTrxAmount, parseTrxDate, parseTrxTab, planImportFromCounts, specForTab,
} from './bankTrxSheet.js'

const TODAY = '2026-08-08'

test('parseTrxAmount : formats des relevés du fichier', () => {
  assert.equal(parseTrxAmount('(32.19)'), -32.19)
  assert.equal(parseTrxAmount('‑531,23 $'), -531.23) // tiret U+2011 Desjardins
  assert.equal(parseTrxAmount('+8 000,00 $'), 8000)
  assert.equal(parseTrxAmount(' 20 000,00 '), 20000)
  assert.equal(parseTrxAmount('1,393.37'), 1393.37)
  assert.equal(parseTrxAmount(' -    '), null)
  assert.equal(parseTrxAmount(''), null)
  assert.equal(parseTrxAmount(null), null)
})

test('parseTrxDate : ISO, numérique voté, mois français collé, anglais', () => {
  assert.equal(parseTrxDate('2026-07-31', { todayIso: TODAY }), '2026-07-31')
  // Visa USD : mois/jour ; Desjardins et BNC : jour/mois.
  assert.equal(parseTrxDate('7/27/2026', { todayIso: TODAY, monthFirst: true }), '2026-07-27')
  assert.equal(parseTrxDate('27/7/2026', { todayIso: TODAY, monthFirst: false }), '2026-07-27')
  // Sans ambiguïté, le vote est ignoré.
  assert.equal(parseTrxDate('27/7/2026', { todayIso: TODAY, monthFirst: true }), '2026-07-27')
  // « 3 AOÛ3 Août » (Desjardins, sans année) : année la plus récente non future.
  assert.equal(parseTrxDate('3 AOÛ3 Août', { todayIso: TODAY }), '2026-08-03')
  assert.equal(parseTrxDate('24 NOV24 Novembre', { todayIso: TODAY }), '2025-11-24')
  assert.equal(parseTrxDate('3 AOÛ 2026', { todayIso: TODAY }), '2026-08-03')
  assert.equal(parseTrxDate('29 Apr, 2025', { todayIso: TODAY }), '2025-04-29')
  assert.equal(parseTrxDate('Frais fixes', { todayIso: TODAY }), null)
  assert.equal(parseTrxDate('', { todayIso: TODAY }), null)
})

test('specForTab : les 11 onglets du fichier sont mappés', () => {
  for (const tab of ['BNC CAD', 'BNC USD', 'BNC Epargne', 'MasterCard', 'Desj CAD', 'Desj USD',
    'Marge Desj', 'VISA CAD', 'Visa USD', 'Venn USD', 'Venn CAD']) {
    assert.ok(specForTab(tab), `onglet ${tab} non mappé`)
  }
  assert.equal(specForTab('Feuille inconnue'), null)
})

test('parseTrxTab : BNC CAD — double ligne d\'entêtes, débit/crédit', () => {
  const grid = [
    [null, null, null, null, null, null, null, ' 1) INSÉRER le nb de lignes requises '],
    [' BNC CAD  (0006-10281-0310224) '],
    [' Date ', ' Description ', ' Référence ', ' Retraits ', ' Dépôts ', ' Solde '], // ancienne entête
    ['Date', 'Description', 'Référence', 'Autres détails', 'Transit émetteur', 'Débit (out)', 'Crédit (in)', 'Solde total', null, 'X'],
    ['2026-08-07', 'REMB. MCR', '60024937974', 'REMB. MCR', null, '850.00', null, '0.83'],
    ['2026-08-07', 'COMPTES DEBITEURS', null, null, null, null, '1,202.67', '1203.31'],
    ['note sans date', 'rapprochement terminé'],
  ]
  const { rows, warnings } = parseTrxTab(grid, specForTab('BNC CAD'), { todayIso: TODAY })
  assert.equal(warnings.length, 0)
  assert.deepEqual(rows, [
    { txn_date: '2026-08-07', sheet_color: null, description: 'REMB. MCR', details: 'REMB. MCR', reference: '60024937974', amount: -850, balance: 0.83 },
    { txn_date: '2026-08-07', sheet_color: null, description: 'COMPTES DEBITEURS', details: null, reference: null, amount: 1202.67, balance: 1203.31 },
  ])
})

test('parseTrxTab : « Autres détails » distinct de la description', () => {
  const grid = [
    ['Date', 'Description', 'Référence', 'Autres détails', 'Transit émetteur', 'Débit (out)', 'Crédit (in)', 'Solde total'],
    ['2026-08-07', 'PMTS ENTREPRISES', 'CPI080000000749', 'NOVO EXPRESS', null, '352.48', null, '850.83'],
  ]
  const { rows } = parseTrxTab(grid, specForTab('BNC CAD'), { todayIso: TODAY })
  assert.equal(rows[0].details, 'NOVO EXPRESS') // la nature réelle de la transaction
  assert.equal(rows[0].description, 'PMTS ENTREPRISES')
})

test('parseTrxTab : Visa — achats en positif dans le fichier, inversés', () => {
  const grid = [
    ['VISA USD'],
    ['Date de la transaction', 'Date de facturation', 'Catégorie', 'Numéro de référence', 'Montant', 'Solde'],
    ['8/1/2026', '8/2/2026', 'Amazon Web Services www.amazon.caON', null, '73.38', '161.51'],
    ['7/27/2026', '7/27/2026', 'VOTRE PAIEMENT - MERCI', null, '(75.42)', '86.30'],
  ]
  const { rows } = parseTrxTab(grid, specForTab('Visa USD'), { todayIso: TODAY })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].txn_date, '2026-08-01') // vote mois/jour (7/27 tranche)
  assert.equal(rows[0].amount, -73.38) // achat → sortie d'argent
  assert.equal(rows[0].description, 'Amazon Web Services www.amazon.caON') // « Catégorie » = description
  assert.equal(rows[1].amount, 75.42) // paiement → entrée
})

test('parseTrxTab : Marge — intérêts + avances positifs, remboursements négatifs', () => {
  const grid = [
    ['MARGE DE CRÉDIT - DESJARDINS'],
    ['Date', 'Description', 'Intérêts (CAD)', 'Avance (CAD)', 'Remb, (CAD)', 'Solde (CAD)'],
    ['3 AOÛ 2026', 'Remboursement automatique /de EOP:531,23$ no', '531.23', null, ' -    ', '98 000,00'],
    ['14 JUL 2026', 'Avance au compte EOP no', null, ' 20 000,00 ', null, '97 000,00'],
    ['9 JUN 2026', 'Remboursement', null, null, '1 000,00', '52 000,00'],
  ]
  const { rows } = parseTrxTab(grid, specForTab('Marge Desj'), { todayIso: TODAY })
  assert.deepEqual(rows.map((r) => r.amount), [531.23, 20000, -1000])
  assert.equal(rows[0].balance, 98000)
})

test('parseTrxTab : Venn — description composée avec le type et le statut', () => {
  const grid = [
    ['VENN - USD'],
    [],
    ['Date', 'Time', 'Description', 'Transaction Type', 'Status', 'Currency', ' Amount ', ' Balance ', null, 'X'],
    ['2026-08-06', '10:00', 'Make', 'Card Payment', 'COMPLETED', 'USD', '-10.59', '36,237.97'],
    ['2026-08-05', '09:00', 'Reward', 'Reward', 'COMPLETED', 'USD', '2.88', '36,248.56'],
    ['2026-07-11', '12:00', 'Circle', 'Card Payment', 'IN_PROGRESS', 'USD', '(367.97)', null],
  ]
  const { rows } = parseTrxTab(grid, specForTab('Venn USD'), { todayIso: TODAY })
  assert.equal(rows[0].description, 'Make — Card Payment')
  assert.equal(rows[0].amount, -10.59)
  assert.equal(rows[1].description, 'Reward') // type identique : pas doublé
  assert.equal(rows[2].description, 'Circle — Card Payment — IN_PROGRESS')
  assert.equal(rows[2].amount, -367.97)
})

test('planImportFromCounts : dédup par (date, montant), occurrences comptées', () => {
  const rows = [
    { txn_date: '2026-08-05', amount: -12.5 },
    { txn_date: '2026-08-05', amount: -12.5 }, // 2 achats identiques le même jour
    { txn_date: '2026-08-04', amount: 1000 },
  ]
  // La base connaît déjà UNE occurrence du -12.50 (importée par collage, avec un
  // libellé différent) : seule la 2e et le 1000 passent.
  const existing = new Map([['2026-08-05|-12.50', 1]])
  const { toInsert, skipped } = planImportFromCounts(rows, existing)
  assert.equal(skipped, 1)
  assert.deepEqual(toInsert.map((r) => `${r.txn_date}|${r.amount}`), ['2026-08-05|-12.5', '2026-08-04|1000'])
  // Re-sync : tout est en base, rien à insérer.
  const again = planImportFromCounts(rows, new Map([['2026-08-05|-12.50', 2], ['2026-08-04|1000.00', 1]]))
  assert.equal(again.toInsert.length, 0)
  assert.equal(again.skipped, 3)
})

test('planImportFromCounts : les dates futures (paiements programmés) sont exclues', () => {
  const rows = [
    { txn_date: '2026-08-11', amount: -22.98 }, // programmé AccèsD, pas encore passé
    { txn_date: '2026-08-07', amount: -50 },
  ]
  const { toInsert, skipped } = planImportFromCounts(rows, new Map(), { maxDate: '2026-08-09' })
  assert.deepEqual(toInsert.map((r) => r.txn_date), ['2026-08-07'])
  assert.equal(skipped, 1)
})

test('parseTrxTab : la couleur de la cellule du montant devient le statut déclaré', () => {
  const grid = [
    ['Date', 'Description', 'Montant', 'Solde'],
    ['2026-08-01', 'AMAZON', '-25,00', '100,00'],
    ['2026-08-02', 'DEPOT', '1 000,00', '1 100,00'],
    ['2026-08-03', 'AKAMAI', '-102,35', '997,65'],
  ]
  // La légende vit dans les colonnes de droite (col 8) : elle ne doit JAMAIS
  // teindre les lignes de données.
  const colorAt = (r, c) => {
    if (c === 8) return 'vert'
    if (c !== 2) return null
    return { 1: 'vert', 2: 'jaune', 3: 'rouge' }[r] || null
  }
  const { rows } = parseTrxTab(grid, null, { todayIso: TODAY, colorAt })
  assert.deepEqual(rows.map((r) => r.sheet_color), ['vert', 'jaune', 'rouge'])
  const sansCouleur = parseTrxTab(grid, null, { todayIso: TODAY }).rows
  assert.deepEqual(sansCouleur.map((r) => r.sheet_color), [null, null, null])
})

test('année ancrée sur la ligne précédente : un onglet qui descend jusqu\'à l\'an dernier', () => {
  // Les relevés Desjardins n'écrivent pas l'année. Un onglet trié du plus
  // récent au plus ancien traverse le 1er janvier : sans ancrage, « 18 AOÛ »
  // en bas de l'onglet était daté de l'année en cours et devenait un doublon
  // introuvable dans QuickBooks (les 12 dernières fausses anomalies).
  const grid = [
    ['Date', 'Description', 'Montant', 'Solde'],
    ['17 AOÛ17 Août', 'Dépôt', '25 000,00', '274,07'],
    ['24 JUL24 Juillet', 'AccèsD', '-147,00', '595,25'],
    ['15 SEP15 Septembre', 'Virement', '-25 000,00', '627,50'],   // ← bascule en 2025
    ['18 AOÛ18 Août', 'Paiement fédéral', '69 371,00', '70 367,02'],
    ['22 JUL22 Juillet', 'Réception EDI', '100 000,00', '100 302,01'],
  ]
  const { rows } = parseTrxTab(grid, null, { todayIso: '2026-08-22' })
  assert.deepEqual(rows.map((r) => r.txn_date),
    ['2026-08-17', '2026-07-24', '2025-09-15', '2025-08-18', '2025-07-22'])
})

test('année ancrée aussi sur un onglet qui monte', () => {
  const grid = [
    ['Date', 'Description', 'Montant'],
    ['22 NOV22 Novembre', 'A', '-10,00'],
    ['3 JAN3 Janvier', 'B', '-20,00'],   // ← passe à l'année suivante
    ['5 FÉV5 Février', 'C', '-30,00'],
  ]
  const { rows } = parseTrxTab(grid, null, { todayIso: '2026-08-22' })
  assert.deepEqual(rows.map((r) => r.txn_date), ['2025-11-22', '2026-01-03', '2026-02-05'])
})

test('une année écrite dans le relevé n\'est jamais réécrite', () => {
  const grid = [
    ['Date', 'Description', 'Montant'],
    ['2026-08-17', 'A', '10,00'],
    ['29 Apr, 2025', 'B', '20,00'],
    ['2026-08-20', 'C', '30,00'], // hors ordre, mais daté explicitement
  ]
  const { rows } = parseTrxTab(grid, null, { todayIso: '2026-08-22' })
  assert.deepEqual(rows.map((r) => r.txn_date), ['2026-08-17', '2025-04-29', '2026-08-20'])
})
