// Champ « Type » du formulaire « Nouvelle entreprise » (Companies.jsx) → SearchableSelect.
// Avant, c'était un <select> natif de 13 options (TYPES), sans recherche, ce qui
// violait la règle CLAUDE.md « tout dropdown > 10 options doit offrir une recherche ».
// C'est le formulaire de création (distinct de CompanyDetail, déjà traité).
//
// Vérifie :
//   1. Le champ Type du formulaire de création est un <button> (SearchableSelect), pas un <select>.
//   2. L'ouvrir révèle un menu en portail avec champ de recherche filtrable.
//   3. Choisir une valeur reflète le libellé dans le bouton, et la création persiste le type.
//
// L'entreprise créée par le test est un record jetable (préfixe « E2E … » + Date.now())
// supprimé dans le hook after(), même en cas d'échec (règle CLAUDE.md).

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

describe('Companies — formulaire Nouvelle entreprise : Type = SearchableSelect', () => {
  let browser, ctx, page, token
  let createdId
  const companyName = `E2E Searchable ${Date.now()}`

  before(async () => {
    const auth = await api(null, 'POST', '/auth/login', { email: EMAIL, password: PASS })
    assert.equal(auth.status, 200, 'login API doit réussir')
    token = auth.body.token

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    // Supprime l'entreprise créée par le test, même en cas d'échec.
    if (token && createdId) {
      await api(token, 'DELETE', `/companies/${createdId}`)
    }
    await browser?.close()
  })

  test('Type est un SearchableSelect filtrable et la création persiste le type', async () => {
    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })

    // Ouvrir la modale « Nouvelle entreprise ».
    await page.locator('button:has-text("Nouvelle entreprise")').click()
    await page.locator('input[required]').first().waitFor({ state: 'visible', timeout: 5000 })

    // 1. Le champ Type est un bouton (SearchableSelect), pas un <select> natif.
    const trigger = page.locator('[data-testid="company-form-type"]')
    await trigger.waitFor({ state: 'visible', timeout: 5000 })
    const tag = await trigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le champ Type doit être un bouton (SearchableSelect)')

    // 2. Ouvrir → menu en portail avec champ de recherche.
    await trigger.click()
    const menu = page.locator('[data-testid="company-form-type-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = menu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    // Le menu liste les 13 types + l'option vide.
    const optionSelector = '[data-testid="company-form-type-menu"] button'
    const total = await page.locator(optionSelector).count()
    assert.ok(total >= 13, `le menu devrait lister tous les types, got ${total}`)

    // 3a. Filtrer sur « Distrib » → restreint la liste.
    await searchInput.fill('Distrib')
    await page.waitForTimeout(150)
    const filtered = await page.locator(optionSelector).count()
    assert.ok(filtered >= 1 && filtered < total, 'le filtre devrait restreindre la liste')

    // 3b. Requête absurde → « Aucun résultat ».
    await searchInput.fill('zzz-aucun-type-zzz')
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Choisir « Distributeur » → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill('Distrib')
    await page.waitForTimeout(150)
    await page.locator(optionSelector, { hasText: 'Distributeur' }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })
    const triggerText = (await trigger.innerText()).trim()
    assert.ok(triggerText.includes('Distributeur'), `le bouton devrait afficher le type choisi, got "${triggerText}"`)

    // 5. Remplir le nom et soumettre → la création persiste le type choisi.
    await page.locator('input[required]').first().fill(companyName)
    await page.locator('button[type="submit"]:has-text("Enregistrer")').click()

    // Récupère l'entreprise créée pour vérifier le type persisté + permettre le cleanup.
    await page.waitForTimeout(1000)
    const list = await api(token, 'GET', `/companies?limit=all`)
    const rows = Array.isArray(list.body) ? list.body : (list.body.data || [])
    const created = rows.find(c => c.name === companyName)
    assert.ok(created, 'l\'entreprise créée doit exister en DB')
    createdId = created.id
    assert.equal(created.type, 'Distributeur', 'le type choisi doit être persisté à la création')
  })
})
