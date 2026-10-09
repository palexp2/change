import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATEMENT_NAMING, dateFromFileName, closeWindow, isClosingDay, fiscalFolderName, isMonthlyStatement, findExisting,
} from './bankStatementDriveFiling.js'

test('noms du Drive : date lue, mois seul = fin de mois', () => {
  assert.equal(dateFromFileName('BNC_CAD_2026-08-31.pdf.pdf'), '2026-08-31')
  assert.equal(dateFromFileName('CARTCRED_CREDCARD_4807_20260915.pdf'), '2026-09-15')
  assert.equal(dateFromFileName('Venn Main CAD Statement - 2026-09.pdf'), '2026-09-30')
  assert.equal(dateFromFileName('9_2_2026.pdf'), null)
})

test('noms produits = format du dossier', () => {
  assert.equal(STATEMENT_NAMING['BNC Épargne'].file('2026-09-30'), 'BNC_Epargne_2026-09-30.pdf')
  assert.equal(STATEMENT_NAMING['MasterCard BNC'].file('2026-10-15'), 'CARTCRED_CREDCARD_4807_20261015.pdf')
  assert.equal(STATEMENT_NAMING['Venn USD'].file('2026-09-30'), 'Venn Main USD Statement - 2026-09.pdf')
})

test('exercice avril → mars', () => {
  assert.equal(fiscalFolderName('2026-03-31'), '2025-2026')
  assert.equal(fiscalFolderName('2026-04-30'), '2026-2027')
  assert.equal(fiscalFolderName('2026-04-02'), '2025-2026') // Visa de mars
  assert.equal(fiscalFolderName('2026-04-15'), '2026-2027') // MasterCard
})

test('fenêtres de clôture du mois', () => {
  assert.deepEqual(closeWindow('eom', '2026-09'), { from: '2026-09-25', to: '2026-10-05' })
  assert.deepEqual(closeWindow('early', '2026-12'), { from: '2027-01-01', to: '2027-01-08' })
  assert.deepEqual(closeWindow('mid', '2026-09'), { from: '2026-10-10', to: '2026-10-22' })
  assert.ok(isClosingDay('eom', '2026-02-28'))
  assert.ok(!isClosingDay('eom', '2026-10-02'))
  assert.ok(isClosingDay('mid', '2026-05-18'))
})

const stmt = { source: 'pdf_texte', status: 'pret', opening_balance: 10, closing_balance: 20, balance_ok: 1, period_start: '2026-09-01', period_end: '2026-09-30' }
test('relevé mensuel complet seulement', () => {
  assert.ok(isMonthlyStatement(stmt, 'eom'))
  assert.ok(!isMonthlyStatement({ ...stmt, source: 'tableur' }, 'eom'))
  assert.ok(!isMonthlyStatement({ ...stmt, balance_ok: 0 }, 'eom'))
  assert.ok(!isMonthlyStatement({ ...stmt, period_start: '2026-09-03', period_end: '2026-10-02' }, 'eom'))
  assert.ok(!isMonthlyStatement({ ...stmt, period_start: '2026-09-25' }, 'eom'))
})

test('déjà au Drive : même fichier ou même clôture', () => {
  const files = [{ id: 'a', name: 'Visa_USD_2026-09-02.pdf', md5Checksum: 'x' }]
  assert.equal(findExisting(files, { md5: 'zz', periodEnd: '2026-09-02' })?.id, 'a')
  assert.equal(findExisting(files, { md5: 'x', periodEnd: '2026-01-01' })?.id, 'a')
  assert.equal(findExisting(files, { md5: 'zz', periodEnd: '2026-10-02' }), null)
})

test('identité : le numéro imprimé désigne le compte', async () => {
  const { identifyStatement } = await import('./bankStatementDriveFiling.js')
  const pad = ' x'.repeat(60)
  assert.equal(identifyStatement(`Sainte-Foy-815-20465-0101247-ET1 COMPTE AVANTAGE ENTREPRISE${pad}`, 'Desjardins USD').verdict, 'wrong')
  assert.equal(identifyStatement(`815-20465-0807914-EOP COMPTE ENTREPRISE $US${pad}`, 'Desjardins USD').verdict, 'ok')
  const m = identifyStatement(`Sainte-Foy-815-20465-0101247-MC2${pad}`, 'Desjardins CAD')
  assert.equal(m.owner, 'Marge Desjardins')
  assert.equal(identifyStatement('', 'BNC CAD').verdict, 'unknown')
})
