// Base HT envoyée à QuickBooks pour un reçu fournisseur. Le bug d'origine : les
// factures Amazon affichent un sous-total TAXES INCLUSES (souvent subtotal == total)
// tout en listant TPS/TVQ — pousser ce subtotal comme HT faisait recompter la taxe
// par QB (ex. reçu ITC 11,19 $ → 11,19 HT + 1,46 taxe = 12,65 $ au lieu de 11,19 $).
// computeReceiptHtBase doit dériver la base de total - taxes quand l'invariant
// subtotal + taxes = total ne tient pas.

import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

// Évite d'ouvrir la vraie DB au chargement de la chaîne d'imports de quickbooks.js.
process.env.DATABASE_PATH = join(tmpdir(), `erp-test-ht-base-${process.pid}.db`)

const { computeReceiptHtBase } = await import('./quickbooks.js')

test('reçu Amazon taxes-incluses (ITC 15mm) — base HT corrigée, pas de double taxe', () => {
  // subtotal == total == 11.19 mais tps 0.49 + tvq 0.97 ⇒ HT réel = 9.73
  const ht = computeReceiptHtBase({ subtotal: 11.19, totalTax: 0.49 + 0.97, total: 11.19 })
  assert.equal(ht, 9.73)
  // Garde-fou comptable : HT + taxes = total exact du reçu.
  assert.ok(Math.abs((ht + 1.46) - 11.19) <= 0.001)
})

test('reçu Amazon cohérent (Jabra) — subtotal préservé, itemisation conservée', () => {
  // subtotal 169.94 + tps 8.50 + tvq 16.96 = 195.40 = total ⇒ on garde subtotal
  const ht = computeReceiptHtBase({ subtotal: 169.94, totalTax: 8.50 + 16.96, total: 195.40 })
  assert.equal(ht, 169.94)
})

test('reçu sans taxe (AWS) — base = subtotal = total', () => {
  const ht = computeReceiptHtBase({ subtotal: 71.06, totalTax: 0, total: 71.06 })
  assert.equal(ht, 71.06)
})

test('écart d’un cent toléré — subtotal conservé malgré arrondi de taxe', () => {
  // 100.00 + 5.00 + 9.98 = 114.98 ; total - taxes = 99.98, mais l'écart ≤ 0,02 $
  // ⇒ on garde subtotal 100.00 (préserve l'itemisation, pas de sur-correction).
  const ht = computeReceiptHtBase({ subtotal: 100.00, totalTax: 14.98, total: 114.98 })
  assert.equal(ht, 100.00)
})

test('total absent — retombe sur subtotal', () => {
  const ht = computeReceiptHtBase({ subtotal: 50, totalTax: 7.49, total: 0 })
  assert.equal(ht, 50)
})

test('subtotal absent et incohérent — dérive de total - taxes', () => {
  const ht = computeReceiptHtBase({ subtotal: 0, totalTax: 1.46, total: 11.19 })
  assert.equal(ht, 9.73)
})
