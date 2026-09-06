// Champs `type: 'select'` des fiches détail Contact / Produit / Employé.
//
// Avant ce correctif, ces pages rendaient TOUT single_select en <select> natif
// inconditionnel (ContactDetail InlineField, ProductDetail / EmployeeDetail .map),
// alors que CompanyDetail applique déjà le pattern CLAUDE.md
// « options.length > 10 ? SearchableSelect : <select> ». Les trois pages héritent
// désormais de la même condition.
//
// Aucun champ select built-in de ces trois pages n'a > 10 options aujourd'hui
// (Genre=3, Approvisionnement=3, Langue=2), donc le rendu visible reste le <select>
// natif — ce test vérifie la NON-régression de la branche ≤ 10 sur chaque page :
//   - le contrôle reste un <select> natif (pas un bouton SearchableSelect),
//   - il liste l'option vide « — » + toutes les options configurées.
// La branche > 10 → SearchableSelect est, elle, déjà couverte par
// companies-form-type-searchable-select.test.js (props et composant identiques).
//
// Test en lecture seule : ne crée ni ne modifie aucun record (pas de cleanup requis).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp$/, '') + '/api'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function firstRow(body) {
  const rows = Array.isArray(body) ? body : (body?.data || [])
  return rows[0]
}

describe('Fiches détail — select natif conservé sous le seuil de 10 options', () => {
  let browser, ctx, page, token
  let employeeId, productId, contactId

  before(async () => {
    const auth = await api(null, 'POST', '/auth/login', { email: EMAIL, password: PASS })
    assert.equal(auth.status, 200, 'login API doit réussir')
    token = auth.body.token

    employeeId = firstRow((await api(token, 'GET', '/employees?limit=1')).body)?.id
    productId = firstRow((await api(token, 'GET', '/products?limit=1')).body)?.id
    contactId = firstRow((await api(token, 'GET', '/contacts?limit=1')).body)?.id
    assert.ok(employeeId && productId && contactId, 'il faut un employé, un produit et un contact existants')

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  // Vérifie qu'un <select> natif contenant `sampleOption` existe, n'est pas un
  // SearchableSelect (bouton), et liste l'option vide « — » + toutes les options.
  async function assertNativeSelect(sampleOption, expectedNonEmptyCount, ctxLabel) {
    const select = page.locator(`select:has(option:has-text("${sampleOption}"))`).first()
    await select.waitFor({ state: 'visible', timeout: 10000 })

    const tag = await select.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'select', `${ctxLabel} : ≤ 10 options doit rester un <select> natif`)

    const optionTexts = await select.locator('option').allInnerTexts()
    assert.ok(optionTexts.includes('—'), `${ctxLabel} : l'option vide « — » doit être présente`)
    const nonEmpty = optionTexts.filter(t => t.trim() && t.trim() !== '—')
    assert.equal(nonEmpty.length, expectedNonEmptyCount,
      `${ctxLabel} : ${expectedNonEmptyCount} options attendues, got ${nonEmpty.length} (${optionTexts.join(', ')})`)
  }

  test('EmployeeDetail — « Genre » (3 options) reste un <select> natif', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'networkidle' })
    // GENDERS = ['Homme', 'Femme', 'Autre']
    await assertNativeSelect('Homme', 3, 'EmployeeDetail/Genre')
  })

  test('ProductDetail — « Approvisionnement » (3 options) reste un <select> natif', async () => {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'networkidle' })
    // PROCUREMENT_TYPES = ['Acheté', 'Fabriqué', 'Drop ship']
    await assertNativeSelect('Acheté', 3, 'ProductDetail/Approvisionnement')
  })

  test('ContactDetail — « Langue » (2 options) reste un <select> natif', async () => {
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    // language options = ['French', 'English']
    await assertNativeSelect('French', 2, 'ContactDetail/Langue')
  })
})
