const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le menu « Compte de paiement » du formulaire de publication QB affiche la devise des
// comptes non-CAD (« Venn USD (Bank · USD) ») : QB refuse un Purchase dont le compte de
// paiement n'est pas dans la devise de la transaction (fournisseur USD → compte USD
// obligatoire, cf. garde-fou serveur) — le badge évite de choisir un compte incompatible.
// Test en lecture seule : aucune sélection persistée, aucun record créé ni modifié.

let browser, ctx, page, token, receiptId

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

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
})

after(async () => {
  await browser?.close()
})

test('les comptes de paiement non-CAD affichent leur devise', async () => {
  await page.goto(`${URL}/sale-receipts/${receiptId}`, { waitUntil: 'networkidle' })

  // Le formulaire QB charge accounts/vendors/tax-codes depuis QB — peut être lent.
  const select = page.getByTestId('qb-payment-select')
  await select.waitFor({ state: 'visible', timeout: 30000 })
  await select.click()

  const portal = page.locator('#qb-select-portal')
  await portal.waitFor({ state: 'visible', timeout: 5000 })
  const labels = await portal.locator('[role="option"], li, button').allTextContents()
  const all = labels.join('\n')

  // Le fichier QB de prod contient des comptes USD (Venn USD, VISA Desjardins USD…) :
  // au moins une option doit porter le badge « · USD », et les comptes CAD n'en ont pas.
  assert.match(all, /\(Bank · USD\)|\(Credit Card · USD\)/, `aucun badge USD dans les options :\n${all}`)
  assert.doesNotMatch(all, /· CAD\)/, 'les comptes CAD ne doivent pas porter de badge devise')

  // Referme sans rien sélectionner (aucune persistance).
  await page.keyboard.press('Escape')
})
