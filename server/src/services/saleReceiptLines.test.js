// Lignes et mémo publiés sur QuickBooks à partir des articles d'un reçu.
// Exigences : chaque ligne d'article devient une ligne QB avec SA description, et le
// mémo reprend les mêmes lignes — descriptions cohérentes des deux côtés. Les montants
// sont mis à l'échelle sur la base HT pour ne jamais perdre les descriptions (même
// quand les prix d'articles sont taxes-incluses).

import test from 'node:test'
import assert from 'node:assert/strict'

// buildReceiptLines est une fonction pure (aucun accès DB). On n'override pas
// DATABASE_PATH : forcer une DB temporaire vide faisait échouer l'import de
// quickbooks.js (« no such table: orders ») quand le fichier tourne seul.
const { buildReceiptLines } = await import('./quickbooks.js')
// NB : le comportement du mémo (buildReceiptMemo) est couvert par saleReceiptMemo.test.js.

const LD = { AccountRef: { value: '42' } }
const sum = lines => Math.round(lines.reduce((s, l) => s + l.Amount, 0) * 100) / 100
const descs = lines => lines.map(l => l.Description)

test('articles HT qui bouclent — une ligne par article, montants et descriptions intacts', () => {
  const items = [{ description: 'Jabra', total: 168.99 }, { description: 'Eco-frais', total: 0.95 }]
  const lines = buildReceiptLines(items, 169.94, { lineDetail: LD })
  assert.equal(lines.length, 2)
  assert.deepEqual(descs(lines), ['Jabra', 'Eco-frais'])
  assert.deepEqual(lines.map(l => l.Amount), [168.99, 0.95])
  assert.equal(lines[0].AccountBasedExpenseLineDetail, LD)
})

test('article taxes-incluses — montant ramené au HT, description conservée', () => {
  // 11.19 taxes-incluses, base HT 9.73 ⇒ une ligne 9.73 « ITC Wrench » (pas « fournisseur »)
  const lines = buildReceiptLines([{ description: 'ITC Wrench', total: 11.19 }], 9.73, { lineDetail: LD })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Description, 'ITC Wrench')
  assert.equal(lines[0].Amount, 9.73)
})

test('plusieurs articles taxes-incluses — mis à l’échelle, somme = base HT, descriptions gardées', () => {
  const items = [{ description: 'A', total: 60 }, { description: 'B', total: 40 }]
  const lines = buildReceiptLines(items, 98, { lineDetail: LD })
  assert.equal(lines.length, 2)
  assert.deepEqual(descs(lines), ['A', 'B'])
  assert.equal(sum(lines), 98, 'somme des lignes = base HT')
})

test('écart d’arrondi reporté sur la dernière ligne', () => {
  const items = [{ description: 'A', total: 1 }, { description: 'B', total: 1 }, { description: 'C', total: 1 }]
  const lines = buildReceiptLines(items, 10, { lineDetail: LD })
  assert.equal(sum(lines), 10, 'somme exacte malgré 10/3')
  assert.deepEqual(descs(lines), ['A', 'B', 'C'])
})

test('articles sans montant — ligne unique au HT avec descriptions jointes', () => {
  const items = [{ description: 'Service A', total: null }, { description: 'Service B', total: null }]
  const lines = buildReceiptLines(items, 50, { lineDetail: LD, fallbackDescription: 'Acme' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Amount, 50)
  assert.equal(lines[0].Description, 'Service A · Service B')
})

test('aucun article — ligne unique au HT avec libellé de repli', () => {
  const lines = buildReceiptLines([], 50, { lineDetail: LD, fallbackDescription: 'Acme Inc' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].Description, 'Acme Inc')
  assert.equal(lines[0].Amount, 50)
})
