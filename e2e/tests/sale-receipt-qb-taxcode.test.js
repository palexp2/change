const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le menu déroulant de code de taxe (formulaire de publication, visible si status=done
// ET non publié) s'affiche, contient les codes voulus et est sélectionnable. Choisir un
// code persiste désormais le code du document + recalcule les taxes (mise à jour live des
// totaux) — on capture et restaure donc tax_code_id + montants du reçu.

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

test('le code de taxe se choisit dans un menu déroulant', async () => {
  await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })

  // Le formulaire QB charge accounts/vendors/tax-codes depuis QB — peut être lent.
  const select = page.getByTestId('qb-taxcode-select')
  await select.waitFor({ state: 'visible', timeout: 30000 })

  // Ouvre le menu et vérifie la présence des codes spécifiques voulus.
  await select.click()
  const portal = page.locator('#qb-select-portal')
  await portal.waitFor({ state: 'visible', timeout: 5000 })
  await assert.doesNotReject(portal.getByText('— Aucune taxe —', { exact: true }).waitFor({ timeout: 5000 }))
  await assert.doesNotReject(portal.getByText('TPS/TVQ repas', { exact: true }).waitFor({ timeout: 5000 }))

  // Sélectionne « TPS/TVQ repas » et vérifie que le bouton reflète le choix.
  await portal.getByText('TPS/TVQ repas', { exact: true }).click()
  await assert.doesNotReject(
    select.getByText('TPS/TVQ repas', { exact: true }).waitFor({ timeout: 5000 }),
    'le menu ne reflète pas le code sélectionné',
  )
})
