// Champ « Phase » du formulaire « Nouvelle entreprise » (Companies.jsx) → SearchableSelect.
// Avant, c'était un <select> natif (PHASES), alors que le champ « Type » juste au-dessus
// dans le même formulaire utilise déjà SearchableSelect, et que CompanyDetail.jsx affiche
// ces mêmes PHASES via SearchableSelect. Incohérence visuelle sur la même liste de valeurs.
//
// Vérifie :
//   1. Le champ Phase du formulaire de création est un <button> (SearchableSelect), pas un <select>.
//   2. L'ouvrir révèle un menu en portail avec champ de recherche filtrable.
//   3. Choisir une valeur reflète le libellé dans le bouton, et la création persiste la phase.
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

describe('Companies — formulaire Nouvelle entreprise : Phase = SearchableSelect', () => {
  let browser, ctx, page, token
  let createdId
  const companyName = `E2E Phase Searchable ${Date.now()}`

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

  test('Phase est un SearchableSelect filtrable et la création persiste la phase', async () => {
    await page.goto(`${URL}/companies`, { waitUntil: 'networkidle' })

    // Ouvrir la modale « Nouvelle entreprise ».
    await page.locator('button:has-text("Nouvelle entreprise")').click()
    await page.locator('input[required]').first().waitFor({ state: 'visible', timeout: 5000 })

    // 1. Le champ Phase est un bouton (SearchableSelect), pas un <select> natif.
    const trigger = page.locator('[data-testid="company-form-phase"]')
    await trigger.waitFor({ state: 'visible', timeout: 5000 })
    const tag = await trigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le champ Phase doit être un bouton (SearchableSelect)')

    // 2. Ouvrir → menu en portail avec champ de recherche.
    await trigger.click()
    const menu = page.locator('[data-testid="company-form-phase-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = menu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    // Le menu liste les 8 phases + l'option vide.
    const optionSelector = '[data-testid="company-form-phase-menu"] button'
    const total = await page.locator(optionSelector).count()
    assert.ok(total >= 8, `le menu devrait lister toutes les phases, got ${total}`)

    // 3a. Filtrer sur « Custom » → restreint la liste.
    await searchInput.fill('Custom')
    await page.waitForTimeout(150)
    const filtered = await page.locator(optionSelector).count()
    assert.ok(filtered >= 1 && filtered < total, 'le filtre devrait restreindre la liste')

    // 3b. Requête absurde → « Aucun résultat ».
    await searchInput.fill('zzz-aucune-phase-zzz')
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Choisir « Customer » → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill('Custom')
    await page.waitForTimeout(150)
    await page.locator(optionSelector, { hasText: 'Customer' }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })
    const triggerText = (await trigger.innerText()).trim()
    assert.ok(triggerText.includes('Customer'), `le bouton devrait afficher la phase choisie, got "${triggerText}"`)

    // 5. Remplir le nom et soumettre → la création persiste la phase choisie.
    await page.locator('input[required]').first().fill(companyName)
    await page.locator('button[type="submit"]:has-text("Enregistrer")').click()

    // Récupère l'entreprise créée pour vérifier la phase persistée + permettre le cleanup.
    await page.waitForTimeout(1000)
    const list = await api(token, 'GET', `/companies?limit=all`)
    const rows = Array.isArray(list.body) ? list.body : (list.body.data || [])
    const created = rows.find(c => c.name === companyName)
    assert.ok(created, 'l\'entreprise créée doit exister en DB')
    createdId = created.id
    assert.equal(created.lifecycle_phase, 'Customer', 'la phase choisie doit être persistée à la création')
  })
})
