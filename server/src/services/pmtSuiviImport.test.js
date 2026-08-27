import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFrDate, parseAmount, classifyDirection, classifyAccount, classifyMethod,
  isGreen, parsePmtSuivi,
} from './pmtSuiviImport.js'

// ── Parsing des cellules ─────────────────────────────────────────────────────

test('dates jour/mois/année, avec ou sans zéro initial', () => {
  assert.equal(parseFrDate('01/08/2026'), '2026-08-01')
  assert.equal(parseFrDate('1/8/2026'), '2026-08-01')
  assert.equal(parseFrDate('14/08/2026'), '2026-08-14')
  assert.equal(parseFrDate(''), null)
  assert.equal(parseFrDate('2026-08-01'), null) // le fichier n'écrit jamais en ISO
})

test('montants : séparateurs de milliers, parenthèses (crédit), devise', () => {
  assert.deepEqual(parseAmount('5,748.75'), { amount: 5748.75, currency: 'CAD', credit: false })
  assert.deepEqual(parseAmount('20,000.00'), { amount: 20000, currency: 'CAD', credit: false })
  assert.deepEqual(parseAmount('(22.68)'), { amount: 22.68, currency: 'CAD', credit: true })
  assert.deepEqual(parseAmount('1448 USD'), { amount: 1448, currency: 'USD', credit: false })
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('0'), null)
})

// C'est la destination du virement qui décide du sens vu du compte projeté.
test('sens : un virement vers le BNC est une ENTRÉE, vers l\'épargne une sortie', () => {
  assert.equal(classifyDirection('Vir Venn CAD à BNC'), 'in')
  assert.equal(classifyDirection('Vir Desj CAD à BNC'), 'in')
  assert.equal(classifyDirection('BNC Épargne à BNC Chèque'), 'in')
  assert.equal(classifyDirection('BNC Chèque à BNC Épargne'), 'out')
  assert.equal(classifyDirection('Les Jardins d\'Inverness'), 'out')
  assert.equal(classifyDirection('Mastercard (renflouement)'), 'out')
})

test('compte : seuls les mouvements du BNC CAD doivent finir dans la projection', () => {
  assert.equal(classifyAccount('Visa USD', 'BNC USD (sur le site de Desjardins)'), 'BNC USD')
  assert.equal(classifyAccount('CT Greenhouse', 'Venn USD (mastercard **** 1427)'), 'Venn USD')
  assert.equal(classifyAccount('Les Jardins d\'Inverness', 'Virement Interac (Antoine Ratheau)'), 'BNC CAD')
})

test('moyen de paiement déduit du commentaire', () => {
  assert.equal(classifyMethod('Virement Interac (Antoine Ratheau)'), 'interac')
  assert.equal(classifyMethod('Paiement avec Code de Paiement'), 'code_paiement')
  assert.equal(classifyMethod('Virement / Transfert entre compte'), 'transfert')
  assert.equal(classifyMethod('Payé par téléphone avec MC'), 'carte')
  assert.equal(classifyMethod(''), 'autre')
})

// Le vert de la colonne Montant est LE signal « passé à la banque ».
test('vert = passé à la banque, tolérant sur la teinte', () => {
  assert.equal(isGreen('00FF00'), true)
  assert.equal(isGreen('FF00FF00'), true)   // ARGB
  assert.equal(isGreen('34A853'), true)     // vert plus doux
  assert.equal(isGreen('FFFFFF'), false)
  assert.equal(isGreen('FFFF00'), false)    // jaune
  assert.equal(isGreen(undefined), false)
})

// ── Analyse de la grille ─────────────────────────────────────────────────────

const HEADER = ['Date du jour', 'Date de la facture', 'Date du Pmt', '# Paiement/Virement', 'Fournisseur', '# Facture', 'Montant', 'Commentaires']

test('grille : une ligne par paiement, vert → passé à la banque', () => {
  const rows = [
    ['PAYÉ'],
    HEADER,
    ['01/08/2026', '29/07/2026', '01/08/2026', '289', "Les Jardins d'Inverness", '4623', '5,748.75', 'Virement Interac (Antoine Ratheau)'],
    ['28/07/2026', '14/07/2026', '14/08/2026', '747', 'Axxess International – CAD', '1180634591-01', '103.48', 'Paiement post-daté'],
    ['03/08/2026', '', '03/08/2026', '44', 'BNC Épargne à BNC Chèque', '', '20,000.00', 'Virement / Transfert entre compte'],
  ]
  // Seule la 1re ligne de données est verte (colonne Montant = index 6, ligne 2).
  const { rows: out, sheet_rows } = parsePmtSuivi({ rows, fills: { '2:6': '00FF00' }, since: '2026-01-01' })
  assert.equal(sheet_rows, 3)
  assert.equal(out.length, 3)

  const [inverness, axxess, transfert] = out
  assert.equal(inverness.payment_date, '2026-08-01')
  assert.equal(inverness.direction, 'out')
  assert.equal(inverness.amount, 5748.75)
  assert.equal(inverness.method, 'interac')
  assert.equal(inverness.cleared, true, 'cellule verte → passé à la banque')

  // Paiement post-daté : la date qui compte est celle du PAIEMENT, pas de la saisie.
  assert.equal(axxess.payment_date, '2026-08-14')
  assert.equal(axxess.cleared, false)

  assert.equal(transfert.direction, 'in')
  assert.equal(transfert.amount, 20000)
})

test('grille : lignes antérieures à `since` ignorées, clés d\'import uniques', () => {
  const rows = [
    HEADER,
    ['12/03/2024', '', '12/03/2024', '165', "Goodwin's Greenhouses", '', '556.05', 'Interac'],
    ['01/07/2026', '', '01/07/2026', '900', 'Doublon', '', '100.00', 'Interac'],
    ['01/07/2026', '', '01/07/2026', '900', 'Doublon', '', '100.00', 'Interac'],
  ]
  const { rows: out } = parsePmtSuivi({ rows, fills: {}, since: '2026-01-01' })
  assert.equal(out.length, 2, 'la ligne de 2024 est hors fenêtre')
  // Deux lignes identiques le même jour sont légitimes : la clé doit les séparer.
  assert.notEqual(out[0].import_key, out[1].import_key)
})

test('grille sans en-tête reconnaissable → erreur explicite', () => {
  assert.throws(() => parsePmtSuivi({ rows: [['a', 'b']], fills: {} }), /en-t/)
})
