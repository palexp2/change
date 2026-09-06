const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Sélectionner un TYPE DE TRANSACTION (statut fiscal) applique automatiquement le CODE
// DE TAXE QB recommandé pour ce type (fiscalStatus.recommendedCode). On choisit
// « Repas et frais de représentation » → le code doit passer à « TPS/TVQ repas » et le
// bandeau « Conforme » (qb-fiscal-ok) doit apparaître.
// Le handler persiste tax_code_id + montants (via changeDocCode) → on capture/restaure.

let browser, ctx, page, token, receiptId, original

before(async () => {
  const login = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  }).then(r => r.json())
  token = login.token
  assert.ok(token, 'login a échoué')

  const list = await fetch(`${URL}/api/sale-receipts?limit=all`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
  const cand = list.data.find(r => r.status === 'done' && !r.quickbooks_id)
  assert.ok(cand, 'un reçu done non publié est requis')
  receiptId = cand.id
  original = {
    tax_code_id: cand.tax_code_id ?? null, subtotal: cand.subtotal ?? null, tps: cand.tps ?? null,
    tvq: cand.tvq ?? null, other_taxes: cand.other_taxes ?? null, total: cand.total ?? null, items: cand.items || [],
  }

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
})

after(async () => {
  if (receiptId && token) {
    await fetch(`${URL}/api/sale-receipts/${receiptId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(original),
    })
  }
  await browser?.close()
})

test('choisir le type de transaction applique le code de taxe recommandé', async () => {
  await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })

  // Le formulaire QB charge accounts/vendors/tax-codes + types depuis QB — peut être lent.
  const txtype = page.getByTestId('qb-txtype-select')
  await txtype.waitFor({ state: 'visible', timeout: 30000 })

  // Sélectionne « Repas et frais de représentation » (recommendedCode = « TPS/TVQ repas »).
  await txtype.click()
  const portal = page.locator('#qb-select-portal')
  await portal.waitFor({ state: 'visible', timeout: 5000 })
  await portal.getByText('Repas et frais de représentation (CTI/RTI 50 %)', { exact: true }).click()

  // Le code de taxe doit AUTOMATIQUEMENT refléter « TPS/TVQ repas ».
  const taxSelect = page.getByTestId('qb-taxcode-select')
  await assert.doesNotReject(
    taxSelect.getByText('TPS/TVQ repas', { exact: true }).waitFor({ timeout: 8000 }),
    'le code de taxe ne s\'est pas mis à jour automatiquement',
  )

  // Et le statut fiscal doit être marqué conforme.
  await assert.doesNotReject(
    page.getByTestId('qb-fiscal-ok').waitFor({ timeout: 8000 }),
    'le bandeau « Conforme » n\'est pas apparu',
  )
})
