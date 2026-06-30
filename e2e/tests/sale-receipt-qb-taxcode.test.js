const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Reçu existant non publié sur QB (le formulaire de publication n'apparaît que si
// status=done ET quickbooks_id null). On NE publie PAS — ce serait un vrai side
// effect QB. On vérifie seulement que le menu déroulant de code de taxe s'affiche,
// contient les codes voulus et est sélectionnable. Aucun écrit DB → pas de cleanup.
const RECEIPT_ID = '3fbf9ea5-2675-4f1a-a0be-54f61581c7d4'

let browser, ctx, page, token

before(async () => {
  const login = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  }).then(r => r.json())
  token = login.token
  assert.ok(token, 'login a échoué')

  const r = await fetch(`${URL}/api/sale-receipts/${RECEIPT_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json())
  assert.equal(r.status, 'done', 'le reçu doit être extrait')
  assert.ok(!r.quickbooks_id, 'le reçu ne doit pas être déjà publié sur QB (sinon pas de formulaire)')

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
})

after(async () => { await browser?.close() })

test('le code de taxe se choisit dans un menu déroulant', async () => {
  await page.goto(`${URL}/sale-receipts/${RECEIPT_ID}`, { waitUntil: 'networkidle' })

  // Le formulaire QB charge accounts/vendors/tax-codes depuis QB — peut être lent.
  const select = page.getByTestId('qb-taxcode-select')
  await select.waitFor({ state: 'visible', timeout: 30000 })

  // Ouvre le menu et vérifie la présence des codes spécifiques voulus.
  await select.click()
  const portal = page.locator('#qb-select-portal')
  await portal.waitFor({ state: 'visible', timeout: 5000 })
  await assert.doesNotReject(portal.getByText('— Aucune taxe —', { exact: true }).waitFor({ timeout: 5000 }))
  await assert.doesNotReject(portal.getByText('TPS/TVQ repas', { exact: true }).waitFor({ timeout: 5000 }))
  await assert.doesNotReject(portal.getByText('TPS/TVQ kilométrage', { exact: true }).waitFor({ timeout: 5000 }))

  // Sélectionne « TPS/TVQ repas » et vérifie que le bouton reflète le choix.
  await portal.getByText('TPS/TVQ repas', { exact: true }).click()
  await assert.doesNotReject(
    select.getByText('TPS/TVQ repas', { exact: true }).waitFor({ timeout: 5000 }),
    'le menu ne reflète pas le code sélectionné',
  )
})
