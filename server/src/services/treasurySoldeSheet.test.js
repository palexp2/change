import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMoney, parseSheetDate, parseSoldeSheet, goneLineOutcome,
  excelSerialToIso, cellMoney, cellDate, verifySoldeChain,
} from './treasurySoldeSheet.js'

// Grille reproduisant l'onglet « Compte chèque » réel. DEUX grilles : ce que
// l'œil voit (`ROWS`, valeurs formatées) et ce que la cellule contient
// (`RAW`) — c'est toute la difficulté du fichier. « 37,591 » vaut 37590,83 et
// « 1,073 » vaut 1072,86 : lire l'affichage fausse le solde sans le dire.
const ROWS = [
  ['Fournisseur', 'Montant ($)', 'Date du paiement ', 'Solde disponible', null, 'Solde disponible', 'Date', null, 'Sorties récurrentes', null, null, null, 'Paie', 'Montant aprox'],
  ['Axxess International – CAD', '103.48', '4 August', '37,487.35', null, '37,591', '8 August', null, 'Jour approx', 'Montant', 'Description', null, '4 August', '25,000'],
  ['Mastercard', '1,073', '5 August', '36,414.49'],
  ['Fabrique Manic', '14,518.14', '29 August', '21,896.35', null, null, null, null, '1', '6 115,89', 'Loyer', null, '18 August', '25,000'],
  [null, null, null, null, null, null, null, null, '5', '(voir le relevé)', 'Mastercard', null, '1 September', '25,000'],
  [null, null, null, null, null, null, null, null, '23', '8,874', 'Dette BDC'],
  [null, null, null, null, null, null, null, null, null, '25,000', 'Paie'],
  [],
  [null, null, null, null, null, null, null, null, null, '= besoin d\'attention'],
]
// 46238 = 2026-08-04, 46242 = 2026-08-08, 46252 = 2026-08-18, 46263 = 2026-08-29.
const RAW = [
  ROWS[0],
  ['Axxess International – CAD', 103.48, 46238, 37487.35, null, 37590.83, 46242, null, 'Jour approx', 'Montant', 'Description', null, 46238, 25000],
  ['Mastercard', 1072.86, 46239, 36414.49],
  ['Fabrique Manic', 14518.14, 46263, 21896.35, null, null, null, null, 1, '6 115,89', 'Loyer', null, 46252, 25000],
  [null, null, null, null, null, null, null, null, 5, '(voir le relevé)', 'Mastercard', null, 46266, 25000],
  [null, null, null, null, null, null, null, null, 23, 8874, 'Dette BDC'],
  [null, null, null, null, null, null, null, null, null, 25000, 'Paie'],
  [],
  [null, null, null, null, null, null, null, null, null, '= besoin d\'attention'],
]

test('parseMoney gère les formats anglais et français', () => {
  assert.equal(parseMoney('14,518.14'), 14518.14)
  assert.equal(parseMoney('6 115,89'), 6115.89)
  assert.equal(parseMoney('1,073'), 1073)
  assert.equal(parseMoney('25,000'), 25000)
  assert.equal(parseMoney('(22.68)'), -22.68)
  assert.equal(parseMoney('(voir le relevé)'), null)
  assert.equal(parseMoney(''), null)
  assert.equal(parseMoney(null), null)
})

test('excelSerialToIso convertit les numéros de série du fichier', () => {
  assert.equal(excelSerialToIso(46238), '2026-08-04')
  assert.equal(excelSerialToIso(46242), '2026-08-08')
  assert.equal(excelSerialToIso(46263), '2026-08-29')
  // Un montant égaré dans une colonne de date ne devient pas une date.
  assert.equal(excelSerialToIso(1073), null)
  assert.equal(excelSerialToIso('4 August'), null)
})

test('cellMoney : la valeur brute prime sur l\'affichage arrondi', () => {
  // Le cœur du problème : « 37,591 » affiché, 37590,83 en cellule.
  assert.equal(cellMoney(37590.83, '37,591'), 37590.83)
  assert.equal(cellMoney(1072.86, '1,073'), 1072.86)
  // Vraie chaîne dans la cellule (bloc des récurrentes) : repli sur le texte.
  assert.equal(cellMoney('6 115,89', '6 115,89'), 6115.89)
  assert.equal(cellMoney(null, '14,518.14'), 14518.14)
  assert.equal(cellMoney(0, ''), null)
  assert.equal(cellMoney(undefined, undefined), null)
})

test('cellDate : numéro de série d\'abord, texte en repli', () => {
  assert.equal(cellDate(46238, '4 August', '2026-08-09'), '2026-08-04')
  assert.equal(cellDate('4 August', '4 August', '2026-08-09'), '2026-08-04')
  assert.equal(cellDate('? ', '? ', '2026-08-09'), null)
})

test('parseSheetDate : mois anglais/français, année inférée au plus proche', () => {
  assert.equal(parseSheetDate('4 August', '2026-08-05'), '2026-08-04')
  assert.equal(parseSheetDate('29 August', '2026-08-05'), '2026-08-29')
  // Janvier vu depuis décembre : c'est janvier PROCHAIN, pas celui d'il y a 11 mois.
  assert.equal(parseSheetDate('15 January', '2026-12-20'), '2027-01-15')
  // Décembre vu depuis janvier : c'est décembre DERNIER.
  assert.equal(parseSheetDate('28 December', '2027-01-05'), '2026-12-28')
  assert.equal(parseSheetDate('4 août', '2026-08-05'), '2026-08-04')
  assert.equal(parseSheetDate('1er août', '2026-08-05'), '2026-08-01')
  assert.equal(parseSheetDate('August 4', '2026-08-05'), '2026-08-04')
  assert.equal(parseSheetDate('04/08/2026', '2026-08-05'), '2026-08-04')
  assert.equal(parseSheetDate('2026-08-04', '2026-08-05'), '2026-08-04')
  assert.equal(parseSheetDate('4 August 2027', '2026-08-05'), '2027-08-04')
  assert.equal(parseSheetDate('n/a', '2026-08-05'), null)
  assert.equal(parseSheetDate('', '2026-08-05'), null)
})

test('parseSoldeSheet lit les valeurs exactes des cellules, pas l\'affichage', () => {
  const parsed = parseSoldeSheet(ROWS, { todayIso: '2026-08-09', raw: RAW })

  // 37590,83 et non 37591 : 0,17 $ d'erreur en moins sur le solde de départ.
  assert.equal(parsed.balance.amount, 37590.83)
  assert.equal(parsed.balance.date, '2026-08-08')

  assert.equal(parsed.planned.length, 3)
  assert.equal(parsed.planned[0].vendor, 'Axxess International – CAD')
  assert.equal(parsed.planned[0].amount, 103.48)
  assert.equal(parsed.planned[0].date, '2026-08-04')
  // 1072,86 et non 1073.
  assert.equal(parsed.planned[1].amount, 1072.86)

  assert.equal(parsed.recurring.length, 4)
  assert.deepEqual(
    parsed.recurring.map(r => ({ label: r.label, day: r.day, amount: r.amount, variable: r.variable })),
    [
      { label: 'Loyer', day: 1, amount: 6115.89, variable: false },
      { label: 'Mastercard', day: 5, amount: null, variable: true },
      { label: 'Dette BDC', day: 23, amount: 8874, variable: false },
      { label: 'Paie', day: null, amount: 25000, variable: false },
    ],
  )

  // Cédule de paie (colonnes de droite) : la cadence réelle aux 2 semaines.
  assert.deepEqual(parsed.payroll.map(p => p.date), ['2026-08-04', '2026-08-18', '2026-09-01'])

  assert.equal(parsed.unparsed.length, 0)
  assert.equal(parsed.anomalies.length, 0)
})

test('parseSoldeSheet : la chaîne du fichier vérifie chaque ligne', () => {
  const parsed = parseSoldeSheet(ROWS, { todayIso: '2026-08-09', raw: RAW })
  assert.equal(parsed.chain.ok, true)
  assert.equal(parsed.chain.checked, 3)
  assert.equal(parsed.chain.breaks.length, 0)
  assert.equal(parsed.planned.every(l => l.verified), true)
  assert.equal(parsed.chain.final_balance, 21896.35)
})

test('parseSoldeSheet sans valeurs brutes : lecture dégradée SIGNALÉE', () => {
  // Sans la grille brute on relit l'affichage : le solde tombe à 37 591 et la
  // chaîne se rompt aussitôt. Le système doit le DIRE, pas s'en accommoder.
  const parsed = parseSoldeSheet(ROWS, { todayIso: '2026-08-09' })
  assert.equal(parsed.balance.amount, 37591)
  assert.equal(parsed.chain.ok, false)
  assert.equal(parsed.chain.balance_suspect, true)
  assert.ok(parsed.anomalies.some(a => a.code === 'valeurs_brutes_absentes'))
  assert.ok(parsed.anomalies.some(a => a.code === 'chaine_rompue' && a.severity === 'error'))
})

test('verifySoldeChain : rupture localisée, ré-ancrage sur le fichier', () => {
  const planned = [
    { row: 2, vendor: 'A', amount: 100, date: '2026-08-04', running_balance: 900, credit: false },
    // Montant mal lu : 50 au lieu de 200 → le solde du fichier ne retombe pas.
    { row: 3, vendor: 'B', amount: 50, date: '2026-08-05', running_balance: 700, credit: false },
    // La ligne suivante reste vérifiable : une erreur ne contamine pas la suite.
    { row: 4, vendor: 'C', amount: 300, date: '2026-08-06', running_balance: 400, credit: false },
  ]
  const chain = verifySoldeChain({ amount: 1000 }, planned)
  assert.equal(chain.ok, false)
  assert.equal(chain.breaks.length, 1)
  assert.equal(chain.breaks[0].row, 3)
  assert.equal(chain.breaks[0].delta, -150)
  assert.equal(chain.balance_suspect, false)
  assert.deepEqual(planned.map(l => l.verified), [true, false, true])
})

test('verifySoldeChain : solde d\'ouverture faux → signalé comme tel', () => {
  const planned = [{ row: 2, vendor: 'A', amount: 100, date: '2026-08-04', running_balance: 900, credit: false }]
  const chain = verifySoldeChain({ amount: 1200 }, planned)
  assert.equal(chain.balance_suspect, true)
  assert.equal(chain.implied_opening, 1000)
  assert.equal(chain.opening_delta, -200)
})

test('parseSoldeSheet : ligne illisible = anomalie bloquante, jamais un silence', () => {
  const rows = [
    ['Fournisseur', 'Montant ($)', 'Date du paiement', 'Solde disponible'],
    ['Fournisseur X', '100.00', '? ', ''],
  ]
  const raw = [rows[0], ['Fournisseur X', 100, '? ', null]]
  const parsed = parseSoldeSheet(rows, { todayIso: '2026-08-05', raw })
  assert.equal(parsed.planned.length, 0)
  assert.equal(parsed.unparsed.length, 1)
  assert.equal(parsed.unparsed[0].vendor, 'Fournisseur X')
  assert.deepEqual(parsed.unparsed[0].missing, ['date'])
  const anomaly = parsed.anomalies.find(a => a.code === 'ligne_illisible')
  assert.ok(anomaly, 'la ligne illisible doit produire une anomalie')
  assert.equal(anomaly.severity, 'error')
  assert.match(anomaly.text, /n'est PAS comptée/)
})

test('parseSoldeSheet signale un fichier qui n\'a pas été mis à jour', () => {
  const parsed = parseSoldeSheet(ROWS, { todayIso: '2026-08-20', raw: RAW })
  assert.ok(parsed.anomalies.some(a => a.code === 'fichier_perime'))
})

test('parseSoldeSheet échoue clairement sans ligne d\'en-têtes', () => {
  assert.throws(() => parseSoldeSheet([['a', 'b'], []], { todayIso: '2026-08-05' }), /en-têtes introuvable/)
})

// Ligne du fichier disparue : c'est le signal « passé à la banque » (Charles
// retire la ligne et met le solde à jour quand le mouvement passe).
test('goneLineOutcome : ligne disparue + date passée → cochage automatique', () => {
  const seen = '2026-08-05T10:00:00.000Z'
  // Date passée (ou aujourd'hui) : le mouvement est passé — coché, peu importe l'origine.
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-04', sheetSeenAt: seen, fromSheet: true }, '2026-08-08'), 'clear')
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-08', sheetSeenAt: seen, fromSheet: false }, '2026-08-08'), 'clear')
  // Date future : plan modifié — la ligne importée est retirée, un paiement né
  // dans l'ERP n'est jamais détruit.
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-20', sheetSeenAt: seen, fromSheet: true }, '2026-08-08'), 'remove')
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-20', sheetSeenAt: seen, fromSheet: false }, '2026-08-08'), 'keep')
})

test('goneLineOutcome : jamais couvert par le fichier (ou décoché à la main) → on ne touche pas', () => {
  // sheet_seen_at NULL = le fichier n'a jamais couvert ce paiement, OU
  // l'utilisateur vient de décocher « Passé » (setCleared remet le champ à
  // NULL) : l'automatisme ne re-coche pas par-dessus sa décision.
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-04', sheetSeenAt: null, fromSheet: false }, '2026-08-08'), 'keep')
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-04', sheetSeenAt: null, fromSheet: true }, '2026-08-08'), 'keep')
  assert.equal(goneLineOutcome({ paymentDate: '2026-08-20', sheetSeenAt: null, fromSheet: true }, '2026-08-08'), 'keep')
})
