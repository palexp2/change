import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, readScreen } from './qbReconcileRobot.js'

test('classify : écran de connexion, revérification, rapprochement', () => {
  assert.equal(classify('https://accounts.intuit.com/app/sign-in', 'Se connecter'), 'login')
  assert.equal(classify('https://accounts.intuit.com/app/sign-in', 'Entrez le code envoyé'), 'verification')
  assert.equal(classify('https://app.qbo.intuit.com/app/reconcile', 'Rapprocher un compte'), 'reconcile')
  assert.equal(classify('https://app.qbo.intuit.com/app/homepage', 'Rapprocher'), 'unknown')
})

test('readScreen : date et solde du dernier relevé', () => {
  const r = readScreen([
    'Quel compte souhaitez-vous rapprocher?',
    'Date de fin du dernier relevé',
    '2026-08-14',
    'Solde de clôture',
    '1 234,56 $',
  ].join('\n'))
  assert.equal(r.lastStatementEndingDate, '2026-08-14')
  assert.equal(r.lastEndingBalance, '1 234,56 $')
})

test('interpretRows : colonnes Paiement / Dépôt d’un compte bancaire', async () => {
  const { interpretRows } = await import('./qbReconcileRobot.js')
  const rows = interpretRows({
    headers: ['Date', 'Type', 'N° réf.', 'Bénéficiaire', 'Paiement (CAD)', 'Dépôt (CAD)', ''],
    rows: [
      { key: '0', cells: ['14/09/2026', 'Dépense', '', 'Desjardins', '42,00 $', '', ''], checked: false, ids: ['17947'] },
      { key: '1', cells: ['01/09/2026', 'Virement', '', '', '', '20 000,00 $', ''], checked: true, ids: [] },
    ],
  }, 'bank')
  assert.deepEqual(rows.map(r => [r.date, r.amount, r.checked]), [['2026-09-14', -42, false], ['2026-09-01', 20000, true]])
  assert.deepEqual(rows[0].ids, ['17947'])
})

test('interpretRows : marge « bank » affichée en carte de crédit (Débit / Paiement)', async () => {
  const { interpretRows } = await import('./qbReconcileRobot.js')
  const rows = interpretRows({
    headers: ['Date', 'Type', 'N° de référence', 'Compte', 'Bénéficiaire', 'Mémo', '', 'Débit (CAD)', 'Paiement (CAD)', ''],
    rows: [
      { key: '0', cells: ['2026-08-11', 'Virement', '', '10200', '', 'Avance', '', '25 000,00', '', ''], checked: false, ids: [] },
      { key: '1', cells: ['2026-08-03', 'Paiement', '', '10200', '', '', '', '', '531,23', ''], checked: false, ids: [] },
    ],
  }, 'bank')
  assert.deepEqual(rows.map(r => [r.date, r.amount]), [['2026-08-11', -25000], ['2026-08-03', 531.23]])
})
