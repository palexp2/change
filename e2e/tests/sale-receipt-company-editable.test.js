const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Reçu existant (facture Bell) — on édite son champ entreprise puis on restaure.
const RECEIPT_ID = '3fbf9ea5-2675-4f1a-a0be-54f61581c7d4'

let browser, ctx, page, token, originalCompany, originalDate

async function api(method, path, body) {
  const res = await fetch(`${URL}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

before(async () => {
  const login = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  }).then(r => r.json())
  token = login.token
  assert.ok(token, 'login a échoué')

  // Capture la valeur courante du champ entreprise pour la restaurer après le test.
  const r = await api('GET', `/sale-receipts/${RECEIPT_ID}`)
  assert.equal(r.status, 200, 'reçu introuvable')
  originalCompany = r.body.company
  originalDate = r.body.receipt_date

  browser = await chromium.launch()
  ctx = await browser.newContext()
  page = await ctx.newPage()
  await page.addInitScript(t => localStorage.setItem('erp_token', t), token)
})

after(async () => {
  // Restaure toujours les valeurs originales, même en cas d'échec.
  if (token) {
    const patch = {}
    if (originalCompany !== undefined) patch.company = originalCompany
    if (originalDate !== undefined) patch.receipt_date = originalDate
    if (Object.keys(patch).length) await api('PATCH', `/sale-receipts/${RECEIPT_ID}`, patch)
  }
  await browser?.close()
})

test('le champ Entreprise est éditable et autosave', async () => {
  await page.goto(`${URL}/sale-receipts/${RECEIPT_ID}`, { waitUntil: 'networkidle' })

  const input = page.getByTestId('receipt-company')
  await input.waitFor({ state: 'visible', timeout: 10000 })

  const newValue = `E2E Fournisseur ${Date.now()}`
  await input.fill(newValue)
  await input.blur()

  // Laisse le PATCH autosave se faire, puis vérifie côté serveur.
  await page.waitForTimeout(1500)
  const after2 = await api('GET', `/sale-receipts/${RECEIPT_ID}`)
  assert.equal(after2.body.company, newValue, 'la valeur éditée n\'a pas été persistée')

  // Vérifie aussi que l'input reflète bien la nouvelle valeur dans le DOM.
  assert.equal(await input.inputValue(), newValue)
})

test('le champ Date s\'affiche en format lisible, est éditable et autosave', async () => {
  await page.goto(`${URL}/sale-receipts/${RECEIPT_ID}`, { waitUntil: 'networkidle' })

  // La date s'affiche d'abord en format lisible (pas d'ISO brut) ; cliquer révèle l'input.
  const dateDisplay = page.getByTestId('receipt-date-display')
  await dateDisplay.waitFor({ state: 'visible', timeout: 10000 })
  const displayText = (await dateDisplay.innerText()).trim()
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(displayText), `la date ne doit pas s'afficher en ISO brut, vu: "${displayText}"`)
  await dateDisplay.click()

  const dateInput = page.getByTestId('receipt-date')
  await dateInput.waitFor({ state: 'visible', timeout: 10000 })

  const newDate = '2025-12-31'
  await dateInput.fill(newDate)
  await dateInput.blur()

  // L'input type=date autosave on change ; laisse le PATCH se faire.
  await page.waitForTimeout(1500)
  const after2 = await api('GET', `/sale-receipts/${RECEIPT_ID}`)
  assert.equal(after2.body.receipt_date, newDate, 'la date éditée n\'a pas été persistée')

  // Après blur, on revient à l'affichage lisible reflétant la nouvelle date.
  await dateDisplay.waitFor({ state: 'visible', timeout: 5000 })
  const newDisplay = (await dateDisplay.innerText()).trim()
  assert.ok(newDisplay.includes('2025'), `l'affichage doit refléter la nouvelle date, vu: "${newDisplay}"`)
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(newDisplay), 'l\'affichage ne doit pas être en ISO brut')
})
