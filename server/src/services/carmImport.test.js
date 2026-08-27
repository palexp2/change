// Parseur du relevé de transactions CARM (GCRA) — tolérance aux formats :
// CSV ou collage tab-séparé, en-têtes EN/FR ou absentes (inférence par
// contenu), dates ISO / jour-mois-année / textuelles, montants EN et FR.
import test from 'node:test'
import assert from 'node:assert/strict'

const { parseCarmStatement, parseCarmDate, parseCarmAmount } = await import('./carmImport.js')

test('dates — ISO, jour/mois/année, textuelles EN et FR', () => {
  assert.equal(parseCarmDate('2026-08-03'), '2026-08-03')
  assert.equal(parseCarmDate('03/08/2026'), '2026-08-03')
  assert.equal(parseCarmDate('August 3, 2026'), '2026-08-03')
  assert.equal(parseCarmDate('3 août 2026'), '2026-08-03')
  assert.equal(parseCarmDate('n/a'), null)
})

test('montants — formats EN, FR, parenthèses et CR négatifs', () => {
  assert.equal(parseCarmAmount('1,234.56 $'), 1234.56)
  assert.equal(parseCarmAmount('1 234,56'), 1234.56)
  assert.equal(parseCarmAmount('(500.00)'), -500)
  assert.equal(parseCarmAmount('500.00 CR'), -500)
  assert.equal(parseCarmAmount('-500'), -500)
  assert.equal(parseCarmAmount('abc'), null)
})

test('CSV avec en-têtes anglaises du portail', () => {
  const text = [
    'Transaction Date,Transaction Type,Transaction Number,Amount,Balance',
    '2026-07-15,Commercial Accounting Declaration,CAD-2026-0012345,"1,234.56","1,234.56"',
    '2026-07-25,Payment,PAY-889900,(1234.56),0.00',
  ].join('\n')
  const { rows, errors, header_found } = parseCarmStatement(text)
  assert.equal(header_found, true)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    { d: rows[0].transaction_date, t: rows[0].transaction_type, n: rows[0].transaction_number, a: rows[0].amount, b: rows[0].balance },
    { d: '2026-07-15', t: 'Commercial Accounting Declaration', n: 'CAD-2026-0012345', a: 1234.56, b: 1234.56 },
  )
  assert.equal(rows[1].amount, -1234.56)
  assert.equal(rows[1].balance, 0)
})

test('collage tab-séparé avec en-têtes françaises', () => {
  const text = [
    'Date de transaction\tType de transaction\tNuméro de transaction\tMontant\tSolde',
    '15/07/2026\tDéclaration en détail\tCAD-2026-0012345\t1 234,56 $\t1 234,56 $',
  ].join('\n')
  const { rows, header_found } = parseCarmStatement(text)
  assert.equal(header_found, true)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].transaction_date, '2026-07-15')
  assert.equal(rows[0].amount, 1234.56)
})

test('sans en-têtes — inférence par contenu (date, numéro, montant, solde)', () => {
  const text = '2026-08-03\tPaiement\tPAY-556677\t-500,00\t250,00'
  const { rows, header_found } = parseCarmStatement(text)
  assert.equal(header_found, false)
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { d: rows[0].transaction_date, t: rows[0].transaction_type, n: rows[0].transaction_number, a: rows[0].amount, b: rows[0].balance },
    { d: '2026-08-03', t: 'Paiement', n: 'PAY-556677', a: -500, b: 250 },
  )
})

test('clés d\'import — stables et uniques même sur lignes identiques', () => {
  const line = '2026-08-03\tPaiement\tPAY-1\t-500,00'
  const { rows } = parseCarmStatement(`${line}\n${line}`)
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].import_key, rows[1].import_key)
  const again = parseCarmStatement(`${line}\n${line}`)
  assert.equal(rows[0].import_key, again.rows[0].import_key)
  assert.equal(rows[1].import_key, again.rows[1].import_key)
})

test('colonne « Amount » vide — le montant est repêché dans la colonne qui en porte', () => {
  const text = [
    'Transaction Date,Transaction Type,Transaction Number,Amount,Total amount,Balance',
    '2026-07-15,Declaration,CAD-2026-0012345,,"1,234.56","1,234.56"',
    '2026-07-25,Payment,PAY-889900,,(1234.56),0.00',
  ].join('\n')
  const { rows, errors, notes } = parseCarmStatement(text)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].amount, 1234.56)
  assert.equal(rows[1].amount, -1234.56)
  assert.equal(rows[0].balance, 1234.56)
  assert.match(notes.join(' '), /montant lu dans/)
})

test('colonnes débit/crédit → montant signé', () => {
  const text = [
    'Posting Date;Activity;Reference;Debit;Credit;Account balance',
    '2026-07-15;Droits et taxes;24BSF123456;1 234,56;;1 234,56',
    '2026-07-25;Paiement reçu;PAY-889900;;1 234,56;0,00',
  ].join('\n')
  const { rows, errors } = parseCarmStatement(text)
  assert.equal(errors.length, 0)
  assert.deepEqual(rows.map(r => r.amount), [1234.56, -1234.56])
  assert.equal(rows[1].balance, 0)
})

test('préambule de rapport, en-têtes approchées et lignes de totaux', () => {
  const text = [
    'Agence des services frontaliers du Canada',
    'Relevé de compte — 3456789012RM0001',
    'Généré le 2026-08-01',
    '',
    'Date de la transaction,Nature de l\'activité,No de déclaration,Montant de la transaction ($ CA),Solde du compte ($ CA)',
    '15/07/2026,Déclaration en détail,24BSF123456,"1 234,56","1 234,56"',
    '25/07/2026,Paiement,PAY-889900,"-1 234,56","0,00"',
    'Total,,,"0,00",',
  ].join('\n')
  const { rows, errors, header_found, columns } = parseCarmStatement(text)
  assert.equal(header_found, true)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].transaction_date, '2026-07-15')
  assert.equal(rows[0].amount, 1234.56)
  assert.equal(columns.amount, 'Montant de la transaction ($ CA)')
})

test('description multi-lignes entre guillemets ne casse pas la ligne', () => {
  const text = [
    'Transaction Date,Description,Amount',
    '2026-07-15,"Droits\net taxes",500.00',
    '2026-07-16,Autre,25.00',
  ].join('\n')
  const { rows, errors } = parseCarmStatement(text)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].description, 'Droits\net taxes')
})

test('en-tête non reconnue sur une ligne — repli sur l\'inférence par contenu', () => {
  const text = [
    'Col A,Col B,Col C,Col D',
    '2026-07-15,Déclaration,24BSF123456,500.00',
  ].join('\n')
  const { rows, errors } = parseCarmStatement(text)
  assert.equal(errors.length, 0)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].transaction_date, '2026-07-15')
  assert.equal(rows[0].amount, 500)
  assert.equal(rows[0].transaction_number, '24BSF123456')
})

test('lignes de bruit ignorées, erreurs remontées ligne par ligne', () => {
  const text = [
    'Transaction Date,Transaction Type,Amount',
    ',,', // vide → ignorée sans erreur
    '2026-07-15,Droits,not-a-number', // montant illisible → erreur
    '2026-07-16,Droits,25.00',
  ].join('\n')
  const { rows, errors } = parseCarmStatement(text)
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /montant illisible/)
})
