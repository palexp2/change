// Le miroir écrit dans le fichier de Charles : ce qui est vérifié ici, c'est
// qu'une ligne tombe À SA DATE et dans LES COLONNES DE SON ONGLET. Une erreur
// de place ou de colonne se voit tout de suite dans un fichier que quelqu'un
// lit tous les jours.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowForTab, planTab, placeMissing, growthDescending, readsBack, monthFirstOf, blankRowFill, rowHeightFill, resolveComment, dataRowHeight, paintRuns, cellsToWrite, reviewCells, dataWidth, balanceCells, detectTabDirection, rowsForBalancePass, STATUS_FILL, dateShape, formatDateLike } from './trxSheetMirror.js'

// Onglet BNC : Date | Description | Référence | Autres détails | … | Débit | Crédit | Solde
const BNC = { date: 0, description: 1, reference: 2, details: 3, debit: 5, credit: 6, balance: 7 }
// Onglet à colonne « Montant » unique, comme les Visa Desjardins.
const VISA = { date: 0, description: 1, amount: 2, balance: 3 }
// Marge de crédit : intérêts, avance, remboursement.
const MARGE = { date: 0, description: 1, interest: 2, advance: 3, remb: 4, balance: 5 }

test('une sortie va dans la colonne Débit de son onglet', () => {
  const cells = rowForTab(
    { txn_date: '2026-09-02', description: 'NOVO EXPRESS', details: 'CPI', reference: 'R1', amount: -120.27, balance: 500, status: 'a_traiter' },
    BNC, {},
  )
  assert.equal(cells[0], '2026-09-02')
  assert.equal(cells[1], 'NOVO EXPRESS')
  assert.equal(cells[3], 'CPI')
  assert.equal(cells[5], '120.27')
  assert.equal(cells[6], '')
  assert.equal(cells[7], '500.00')
})

test('une entrée va dans la colonne Crédit', () => {
  const cells = rowForTab({ txn_date: '2026-09-02', amount: 3687.08, balance: null, status: 'rapproche' }, BNC, {})
  assert.equal(cells[5], '')
  assert.equal(cells[6], '3687.08')
  assert.equal(cells[7], '')
})

test('sur une Visa Desjardins, un achat se réécrit en positif comme au relevé', () => {
  const cells = rowForTab({ txn_date: '2026-09-02', amount: -45.2, status: 'a_traiter' }, VISA, { invert: true })
  assert.equal(cells[2], '45.20')
  // Le même achat sur un onglet ordinaire garde son signe.
  assert.equal(rowForTab({ txn_date: '2026-09-02', amount: -45.2, status: 'a_traiter' }, VISA, {})[2], '-45.20')
})

test('sur la marge, une avance et un remboursement ne vont pas dans la même colonne', () => {
  assert.equal(rowForTab({ txn_date: '2026-09-02', amount: 1000, status: 'a_traiter' }, MARGE, {})[3], '1000.00')
  assert.equal(rowForTab({ txn_date: '2026-09-02', amount: -800, status: 'a_traiter' }, MARGE, {})[4], '800.00')
})

test('aucune colonne inventée : ce que l’ERP ignore reste vide', () => {
  const cells = rowForTab({ txn_date: '2026-09-02', amount: -10, status: 'a_traiter' }, BNC, {})
  assert.equal(cells[2], '')
  assert.equal(cells[4], '')
})

// ── Ce qui manque au fichier, et ce qui s'y trouve déjà ─────────────────────

test('une ligne déjà dans le fichier est repeinte, pas ajoutée', () => {
  const fileRows = [{ rowIndex: 7, txn_date: '2026-09-02', amount: -45.2 }]
  const txn = { txn_date: '2026-09-02', amount: -45.2, status: 'rapproche' }
  const { missing, paint } = planTab(fileRows, [txn])
  assert.equal(missing.length, 0)
  assert.deepEqual(paint, [{ rowIndex: 7, status: 'rapproche', txn }])
})

test('deux achats identiques le même jour, un seul au fichier : un à ajouter', () => {
  const fileRows = [{ rowIndex: 7, txn_date: '2026-09-02', amount: -5 }]
  const txns = [
    { txn_date: '2026-09-02', amount: -5, status: 'rapproche' },
    { txn_date: '2026-09-02', amount: -5, status: 'a_traiter' },
  ]
  const { missing, paint } = planTab(fileRows, txns)
  assert.equal(missing.length, 1)
  assert.equal(paint.length, 1)
})

// ── La place de chaque ligne neuve ──────────────────────────────────────────

test('sur un onglet du plus récent au plus ancien, une ligne se glisse à sa date', () => {
  // Le fichier : 09-10, 09-05, 09-01. Une ligne du 09-07 va entre les deux
  // premières, pas en tête.
  const fileRows = [
    { rowIndex: 6, txn_date: '2026-09-10', amount: -1 },
    { rowIndex: 7, txn_date: '2026-09-05', amount: -2 },
    { rowIndex: 8, txn_date: '2026-09-01', amount: -3 },
  ]
  const places = placeMissing(fileRows, [{ txn_date: '2026-09-07', amount: -9 }], true, 5, 9)
  assert.equal(places.length, 1)
  assert.equal(places[0].at, 7)
})

test('une ligne plus récente que tout le fichier va bien en tête', () => {
  const fileRows = [{ rowIndex: 6, txn_date: '2026-09-10', amount: -1 }]
  const places = placeMissing(fileRows, [{ txn_date: '2026-09-20', amount: -9 }], true, 5, 7)
  assert.equal(places[0].at, 6)
})

test('une ligne plus ancienne que tout le fichier va à la fin, pas en tête', () => {
  // C'est l'erreur qu'on ne veut plus : un relevé de janvier posé au-dessus du
  // bloc de septembre.
  const fileRows = [
    { rowIndex: 6, txn_date: '2026-09-10', amount: -1 },
    { rowIndex: 7, txn_date: '2026-09-05', amount: -2 },
  ]
  const places = placeMissing(fileRows, [{ txn_date: '2026-01-06', amount: -9 }], true, 5, 8)
  assert.equal(places[0].at, 8)
})

test('plusieurs lignes neuves gardent leur ordre une fois posées', () => {
  const fileRows = [
    { rowIndex: 6, txn_date: '2026-09-10', amount: -1 },
    { rowIndex: 7, txn_date: '2026-09-01', amount: -2 },
  ]
  const places = placeMissing(fileRows, [
    { txn_date: '2026-09-08', amount: -8 },
    { txn_date: '2026-09-05', amount: -5 },
  ], true, 5, 8)
  // Appliquées dans l'ordre rendu, la plus récente finit au-dessus.
  const grid = ['09-10', '09-01']
  for (const p of places) grid.splice(p.at - 6, 0, p.txn.txn_date.slice(5))
  assert.deepEqual(grid, ['09-10', '09-08', '09-05', '09-01'])
})

test('sur un onglet qui monte, la place se cherche dans l’autre sens', () => {
  const fileRows = [
    { rowIndex: 6, txn_date: '2026-09-01', amount: -1 },
    { rowIndex: 7, txn_date: '2026-09-10', amount: -2 },
  ]
  const places = placeMissing(fileRows, [{ txn_date: '2026-09-05', amount: -9 }], false, 5, 8)
  assert.equal(places[0].at, 7)
})

test('une ligne en tête se range sous la ligne de séparation, pas au-dessus', () => {
  // Venn USD : en-tête ligne 5, fine ligne vide en 6, données dès la 7.
  const fileRows = [{ rowIndex: 6, txn_date: '2026-09-15', amount: -1 }]
  const places = placeMissing(fileRows, [{ txn_date: '2026-09-21', amount: -9 }], true, 4, 8)
  assert.equal(places[0].at, 6)
})

test('une ligne neuve prend la hauteur des lignes de données', () => {
  const fileRows = [{ rowIndex: 6 }, { rowIndex: 7 }, { rowIndex: 8 }]
  const heights = [20, 20, 20, 20, 20, 10, 21, 21, 20]
  assert.equal(dataRowHeight(fileRows, heights), 21)
  const [req] = rowHeightFill(42, 5, 21)
  assert.equal(req.updateDimensionProperties.properties.pixelSize, 21)
  assert.deepEqual(rowHeightFill(42, 5, null), [])
})

test('un fichier vide : la ligne se pose sous l’en-tête', () => {
  const places = placeMissing([], [{ txn_date: '2026-09-05', amount: -9 }], true, 5, 6)
  assert.equal(places[0].at, 6)
})

// ── Peinture ────────────────────────────────────────────────────────────────

test('les lignes voisines de même statut sont peintes d’un seul geste', () => {
  const runs = paintRuns([
    { rowIndex: 10, status: 'rapproche' },
    { rowIndex: 11, status: 'rapproche' },
    { rowIndex: 12, status: 'a_traiter' },
  ], 42, 8)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].repeatCell.range.startRowIndex, 10)
  assert.equal(runs[0].repeatCell.range.endRowIndex, 12)
  assert.deepEqual(runs[0].repeatCell.cell.userEnteredFormat.backgroundColor, STATUS_FILL.rapproche)
})

test('des lignes non voisines ne sont pas fusionnées', () => {
  const runs = paintRuns([
    { rowIndex: 10, status: 'rapproche' },
    { rowIndex: 30, status: 'rapproche' },
  ], 42, 8)
  assert.equal(runs.length, 2)
})

test('chaque statut a sa couleur', () => {
  for (const st of ['a_traiter', 'facture_recue', 'comptabilise', 'rapproche', 'ignore']) {
    assert.ok(STATUS_FILL[st], `couleur manquante pour ${st}`)
  }
})

// ── La ligne ajoutée doit ressembler à ses voisines ─────────────────────────

test('la forme des dates s’apprend sur l’onglet', () => {
  assert.equal(dateShape(['2026-09-11', '2026-09-10', '2026-09-08']), 'ISO')
  // « 8/1/2026 » et « 7/27/2026 » : le mois d'abord (27 > 12 le prouve).
  assert.equal(dateShape(['8/1/2026', '7/27/2026', '7/15/2026']), 'M/D/YYYY')
  // « 27/7/2026 » : le jour d'abord.
  assert.equal(dateShape(['27/7/2026', '15/7/2026']), 'D/M/YYYY')
  // Rien de reconnaissable : on reste en ISO plutôt que d'inventer.
  assert.equal(dateShape(['23 DÉC23 Décembre', '']), 'ISO')
})

test('une date neuve s’écrit comme celles de l’onglet', () => {
  assert.equal(formatDateLike('2026-08-03', 'ISO'), '2026-08-03')
  assert.equal(formatDateLike('2026-08-03', 'M/D/YYYY'), '8/3/2026')
  assert.equal(formatDateLike('2026-08-03', 'D/M/YYYY'), '3/8/2026')
})

test('la forme voulue arrive bien dans la cellule', () => {
  const cells = rowForTab({ txn_date: '2026-08-03', amount: -10, status: 'a_traiter' },
    { date: 0, description: 1, amount: 2 }, {}, 'M/D/YYYY')
  assert.equal(cells[0], '8/3/2026')
})

// ── Statut et solde sur les lignes DÉJÀ au fichier ──────────────────────────

const BNC_STATUS = { ...BNC, status: 8 }

test('une cellule déjà juste n’est pas réécrite', () => {
  const paired = [{ rowIndex: 4, txn: { bank_state: 'complete' }, current: { status: 'Completed' } }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'BNC'), [])
})

test('un statut manquant est écrit dans sa colonne', () => {
  const paired = [{ rowIndex: 4, txn: { bank_state: 'en_attente' }, current: { status: '' } }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'Venn USD'), [
    { range: 'Venn USD!I5', values: [['Pending']] },
  ])
})

// Une carte n'est ni « Completed » ni « Autorisée » d'office : on n'écrit que
// ce que la banque dit, c'est-à-dire « En attente », et rien sinon.
test('sur une carte, l’état vient du document — sans état connu, rien', () => {
  const paired = [
    // Aucun état lu à l'import : la cellule reste vide.
    { rowIndex: 4, txn: { bank_state: null }, current: { status: '' } },
    { rowIndex: 5, txn: { bank_state: 'en_attente' }, current: { status: '' } },
    { rowIndex: 6, txn: { bank_state: 'complete' }, current: { status: '' } },
  ]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'MasterCard', 'card'), [
    { range: 'MasterCard!I6', values: [['En attente']] },
    { range: 'MasterCard!I7', values: [['Autorisée']] },
  ])
})

test('un statut déjà écrit dans le fichier n’est jamais écrasé', () => {
  const paired = [{ rowIndex: 4, txn: { bank_state: 'en_attente' }, current: { status: 'Autorisée' } }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'MasterCard', 'card'), [])
})

test('une ligne de carte sans état connu sort sans statut inventé', () => {
  const brute = { txn_date: '2026-09-15', amount: -60.95, status: 'a_traiter' }
  assert.equal(rowForTab(brute, BNC_STATUS, {}, 'ISO', 'card')[8], '')
  assert.equal(rowForTab({ ...brute, bank_state: 'en_attente' }, BNC_STATUS, {}, 'ISO', 'card')[8], 'En attente')
})

test('une ligne neuve (déjà écrite en entier) n’est pas retouchée', () => {
  const paired = [{ rowIndex: 9, fresh: true, txn: { bank_state: 'complete' }, current: null }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'BNC'), [])
})

test('planTab rend la transaction appariée, pour pouvoir écrire ses cellules', () => {
  const fileRows = [{ rowIndex: 3, txn_date: '2026-09-02', amount: -120.27 }]
  const txns = [{ id: 't1', txn_date: '2026-09-02', amount: -120.27, status: 'rapproche', bank_state: 'complete' }]
  const { paint, missing } = planTab(fileRows, txns)
  assert.equal(missing.length, 0)
  assert.equal(paint[0].txn.id, 't1')
})

// ── Le solde, dans l'ordre du fichier ───────────────────────────────────────

// Onglet de carte qui descend (le plus récent en haut) : un achat fait monter
// le solde dû, donc en descendant (vers le passé) il baisse.
const carte = [
  { rowIndex: 5, amount: -60.95, grey: false, printed: null },
  { rowIndex: 6, amount: -2, grey: true, printed: null },
  { rowIndex: 7, amount: -174.29, grey: false, printed: null },
  { rowIndex: 8, amount: -84.64, grey: false, printed: 4897.98 },
]

test('les trous se comblent depuis le solde imprimé le plus proche', () => {
  const out = balanceCells(carte, { direction: -1, descending: true, title: 'MasterCard', balanceCol: 7 })
  assert.deepEqual(out, [
    { range: 'MasterCard!H6', values: [['5133.22']] },
    { range: 'MasterCard!H7', values: [['5072.27']] },
    { range: 'MasterCard!H8', values: [['5072.27']] },
  ])
})

test('une ligne grise porte le solde de sa voisine, sans le déplacer', () => {
  const out = balanceCells(carte, { direction: -1, descending: true, title: 'MC', balanceCol: 7 })
  const grise = out.find((c) => c.range === 'MC!H7')
  const dessous = out.find((c) => c.range === 'MC!H8')
  assert.equal(grise.values[0][0], dessous.values[0][0])
})

test('sans aucun solde imprimé, on part de celui lu à la banque', () => {
  const rows = [
    { rowIndex: 3, amount: -60, grey: false, printed: null },
    { rowIndex: 4, amount: -40, grey: false, printed: null },
  ]
  const out = balanceCells(rows, { direction: -1, descending: true, bankBalance: 100, title: 'MC', balanceCol: 7 })
  assert.deepEqual(out, [
    { range: 'MC!H4', values: [['100.00']] },
    { range: 'MC!H5', values: [['40.00']] },
  ])
})

test('sans solde imprimé ni solde de banque, rien n’est écrit', () => {
  const rows = [{ rowIndex: 3, amount: -60, grey: false, printed: null }]
  assert.deepEqual(balanceCells(rows, { direction: 1, descending: true, title: 'X', balanceCol: 7 }), [])
})

test('le sens du solde se déduit des soldes imprimés de l’onglet', () => {
  // Compte de banque qui descend : 1000 puis, plus bas (plus ancien), 1100
  // après un retrait de 100 → le solde monte avec un dépôt (+1).
  const banque = [
    { rowIndex: 3, amount: -100, grey: false, printed: 1000 },
    { rowIndex: 4, amount: -50, grey: false, printed: 1100 },
  ]
  assert.equal(detectTabDirection(banque, true, -1), 1)
  // Carte : 4 897,98 puis, plus bas, 4 813,34 avant l'achat de 84,64.
  const cartePrintee = [
    { rowIndex: 8, amount: -84.64, grey: false, printed: 4897.98 },
    { rowIndex: 9, amount: -30.54, grey: false, printed: 4813.34 },
  ]
  assert.equal(detectTabDirection(cartePrintee, true, 1), -1)
  // Un seul solde imprimé : rien à déduire, on garde la nature du compte.
  assert.equal(detectTabDirection(carte, true, -1), -1)
})

test('un solde écrit par un passage précédent est recalculé, pas pris pour ancre', () => {
  const fileRows = [
    { rowIndex: 5, txn_date: '2026-09-11', amount: -174.29 },
    { rowIndex: 6, txn_date: '2026-09-07', amount: -84.64 },
  ]
  const grid = []
  grid[5] = []; grid[5][7] = '5215.07'   // écrit par un passage précédent
  grid[6] = []; grid[6][7] = '4,897.98'  // imprimé par la banque
  const txns = [
    { txn_date: '2026-09-11', amount: -174.29, balance: null, status: 'rapproche' },
    { txn_date: '2026-09-07', amount: -84.64, balance: 4897.98, status: 'rapproche' },
  ]
  const rows = rowsForBalancePass(fileRows, grid, { balance: 7 }, txns)
  assert.equal(rows[0].printed, null)
  assert.equal(rows[1].printed, 4897.98)
  const out = balanceCells(rows, { direction: -1, descending: true, title: 'MC', balanceCol: 7 })
  assert.deepEqual(out, [{ range: 'MC!H6', values: [['5072.27']] }])
})

test('une ligne du fichier inconnue de l’ERP garde son solde', () => {
  const fileRows = [{ rowIndex: 4, txn_date: '2026-09-11', amount: -50 }]
  const grid = []; grid[4] = []; grid[4][7] = '1,000.00'
  const rows = rowsForBalancePass(fileRows, grid, { balance: 7 }, [])
  assert.equal(rows[0].printed, 1000)
})

test('un solde affiché sans son signe est remis comme la banque l’a imprimé', () => {
  const rows = [{ rowIndex: 4, amount: -4664.11, grey: false, printed: 2907.31, current: 2907.31, bank: -2907.31 }]
  assert.deepEqual(balanceCells(rows, { direction: 1, descending: true, title: 'BNC', balanceCol: 7 }), [
    { range: 'BNC!H5', values: [['-2907.31']] },
  ])
})

test('un solde nul écrit «  -  » n’est pas pris pour une cellule vide', () => {
  const rows = rowsForBalancePass(
    [{ rowIndex: 4, txn_date: '2026-09-02', amount: -45.2 }],
    [[], [], [], [], ['2026-09-02', '', '', '', '', '', '  -    ']],
    { balance: 6 }, [],
  )
  assert.equal(rows[0].printed, 0)
})

test('une ligne « En attente » que la banque dit passée est mise à jour', () => {
  const paired = [{ rowIndex: 4, txn: { bank_state: 'autorise' }, current: { status: 'En attente' } }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'MasterCard', 'card'), [
    { range: 'MasterCard!I5', values: [['Autorisée']] },
  ])
})

test('l’inverse n’arrive jamais : « Autorisée » ne redevient pas « En attente »', () => {
  const paired = [{ rowIndex: 4, txn: { bank_state: 'en_attente' }, current: { status: 'Autorisée' } }]
  assert.deepEqual(cellsToWrite(paired, BNC_STATUS, 'MasterCard', 'card'), [])
})

// ── La colonne « X » : la relecture de Michel ───────────────────────────────
// Le classeur porte déjà cette colonne ; Boréal n'y pose et n'y retire qu'un X
// isolé, et ne touche jamais à ce que quelqu'un y a écrit.
const BNC_X = { ...BNC, review: 9 }

test('une ligne marquée reçoit son X dans la colonne du fichier', () => {
  const paired = [{ rowIndex: 7, txn: { review_flag: 1 }, current: { review: '' } }]
  assert.deepEqual(reviewCells(paired, BNC_X, 'BNC CAD'), [
    { range: 'BNC CAD!J8', values: [['X']] },
  ])
})

test('un X déjà présent n’est pas réécrit', () => {
  const paired = [{ rowIndex: 7, txn: { review_flag: 1 }, current: { review: 'X' } }]
  assert.deepEqual(reviewCells(paired, BNC_X, 'BNC CAD'), [])
})

test('la marque retirée efface le X', () => {
  const paired = [{ rowIndex: 7, txn: { review_flag: 0 }, current: { review: 'X' } }]
  assert.deepEqual(reviewCells(paired, BNC_X, 'BNC CAD'), [
    { range: 'BNC CAD!J8', values: [['']] },
  ])
})

test('une note écrite à la main dans la colonne n’est jamais effacée', () => {
  const paired = [{ rowIndex: 7, txn: { review_flag: 0 }, current: { review: 'AL' } }]
  assert.deepEqual(reviewCells(paired, BNC_X, 'BNC CAD'), [])
})

test('sans colonne X dans l’onglet, on n’écrit rien', () => {
  assert.deepEqual(reviewCells([{ rowIndex: 7, txn: { review_flag: 1 } }], BNC, 'BNC CAD'), [])
})

test('la colonne X ne compte pas dans la largeur des données', () => {
  assert.equal(dataWidth(BNC_X), 8)
  const cells = rowForTab(
    { txn_date: '2026-09-02', description: 'X', amount: -10, balance: 5, status: 'a_traiter' },
    BNC_X, {},
  )
  assert.equal(cells.length, 8)
})

// ── Sens de croissance d'un onglet ──────────────────────────────────────────

test('un onglet qui descend reçoit ses lignes en tête', () => {
  assert.equal(growthDescending(['2026-09-18', '2026-09-10', '2026-08-01']), true)
})

test('un vieux bloc à l’envers en tête ne décide plus du sens', () => {
  // VISA CAD : un bloc 2025→2024 rangé à l'envers, puis tout le reste à
  // l'endroit. Vu en entier, c'est 50/50 ; la fin, elle, monte clairement.
  const dates = [
    '2025-04-29', '2025-04-27', '2025-04-25', '2025-04-22', '2025-04-19',
    '2024-12-27', '2024-11-27', '2024-10-26',
    '2025-05-02', '2025-06-18', '2025-10-01', '2025-12-17',
    '2026-02-02', '2026-04-24', '2026-05-25', '2026-06-23', '2026-07-24',
  ]
  assert.equal(growthDescending(dates), false)
})

test('une ligne neuve se pose à la fin d’un onglet qui monte, pas dans son vieux bloc', () => {
  const fileRows = [
    { rowIndex: 4, txn_date: '2025-04-29' },
    { rowIndex: 5, txn_date: '2024-10-26' },
    { rowIndex: 6, txn_date: '2026-06-23' },
    { rowIndex: 7, txn_date: '2026-07-24' },
  ]
  const places = placeMissing(fileRows, [{ txn_date: '2026-09-15' }], false, 3, 8)
  assert.equal(places[0].at, 8)
})

// ── Une ligne posée doit pouvoir se relire ──────────────────────────────────

test('une opération de 0,00 $ n’est pas écrite : le fichier ne la relirait pas', () => {
  const txn = { txn_date: '2026-08-03', description: 'GUILLAUME LAMBERT', amount: 0 }
  assert.equal(readsBack(txn, VISA, {}, 'M/D/YYYY', 'card', true), false)
})

test('une date écrite dans le sens de l’onglet se relit à la même date', () => {
  const txn = { txn_date: '2026-08-03', description: 'AWS', amount: -73.46 }
  assert.equal(readsBack(txn, VISA, {}, 'M/D/YYYY', 'card', true), true)
  // Le même « 3/8/2026 » relu par un onglet mois-premier donnerait le 8 mars.
  assert.equal(readsBack(txn, VISA, {}, 'D/M/YYYY', 'card', true), false)
})

test('le sens mois/jour se lit dans les dates non ambiguës de l’onglet', () => {
  const grid = [['8/24/2026'], ['9/2/2026'], ['3/8/2026']]
  assert.equal(monthFirstOf(grid, { date: 0 }), true)
})


test('une ligne neuve n’emporte aucun fond hérité, repère de Michel compris', () => {
  const [req] = blankRowFill(42, 17)
  assert.equal(req.repeatCell.range.sheetId, 42)
  assert.equal(req.repeatCell.range.startRowIndex, 17)
  assert.equal(req.repeatCell.range.endRowIndex, 18)
  // Pas de borne de colonne : la ligne entière, jusqu'aux colonnes de Michel.
  assert.equal(req.repeatCell.range.startColumnIndex, undefined)
  assert.match(req.repeatCell.fields, /backgroundColor/)
})

test('la peinture du statut s’arrête au bloc de données', () => {
  // La marque de relecture et les repères de Michel vivent à droite : la
  // largeur peinte ne doit jamais les atteindre.
  const runs = paintRuns([{ rowIndex: 10, status: 'rapproche' }], 1, dataWidth({ date: 0, description: 1, amount: 2, balance: 3, review: 8 }))
  assert.equal(runs[0].repeatCell.range.endColumnIndex, 4)
})

// Les intérêts d'une marge ne bougent plus le solde : les lignes du fichier qui
// n'en portent QUE gardent pourtant leur ancienne transaction en base, et le
// miroir doit les reconnaître au lieu d'en réécrire une nouvelle.
test('planTab : une ligne d\'intérêts seuls reconnaît son ancienne transaction', () => {
  const fileRows = [{ rowIndex: 3, txn_date: '2026-08-03', amount: null, alt_amount: 531.23 }]
  const { missing, paint } = planTab(fileRows, [{ txn_date: '2026-08-03', amount: 531.23, status: 'rapproche' }])
  assert.equal(missing.length, 0)
  assert.equal(paint[0].rowIndex, 3)
})

test('planTab : une ligne ne sert qu\'une fois, même indexée deux fois', () => {
  const fileRows = [{ rowIndex: 4, txn_date: '2026-09-01', amount: -19000, alt_amount: -18313.11 }]
  const { missing, paint } = planTab(fileRows, [
    { txn_date: '2026-09-01', amount: -19000, status: 'a_traiter' },
    { txn_date: '2026-09-01', amount: -18313.11, status: 'a_traiter' },
  ])
  assert.equal(paint.length, 1)
  assert.equal(missing.length, 1)
})

// ── Commentaire dans les deux sens ──────────────────────────────────────────

test('un commentaire écrit au fichier entre dans Boréal', () => {
  assert.deepEqual(resolveComment(null, 'vu avec Martin', null), { value: 'vu avec Martin', toErp: true })
  assert.deepEqual(resolveComment('ancien', 'nouveau', 'ancien'), { value: 'nouveau', toErp: true })
})

test('un commentaire écrit dans Boréal part au fichier', () => {
  assert.deepEqual(resolveComment('facture manquante', '', null), { value: 'facture manquante', toFile: true })
  assert.deepEqual(resolveComment('nouveau', 'ancien', 'ancien'), { value: 'nouveau', toFile: true })
})

test('un commentaire effacé d’un côté s’efface de l’autre', () => {
  assert.deepEqual(resolveComment('', 'texte', 'texte'), { value: '', toFile: true })
  assert.deepEqual(resolveComment('texte', '', 'texte'), { value: '', toErp: true })
})

test('changé des deux côtés : les deux textes sont gardés', () => {
  assert.deepEqual(resolveComment('A', 'B', 'X'), { value: 'B · A', toErp: true, toFile: true })
  assert.deepEqual(resolveComment('ok', 'ok, vu', 'X'), { value: 'ok, vu', toErp: true })
  assert.deepEqual(resolveComment(' ok ', 'ok', null), { value: 'ok' })
})
