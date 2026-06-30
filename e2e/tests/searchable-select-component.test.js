// SearchableSelect — composant réutilisable de dropdown avec recherche live
// (règle de design CLAUDE.md « dropdowns avec recherche »).
//
// Vérifie sur la modale "Nouvel envoi" (Envois.jsx) que les <select> natifs
// commande/adresse ont été remplacés par le composant SearchableSelect :
//   1. Le déclencheur est un bouton (testId) et non un <select> natif.
//   2. Cliquer ouvre un menu en portail avec un champ de recherche.
//   3. Taper filtre les options en direct (et "Aucun résultat" si rien ne matche).
//   4. Choisir une option referme le menu et reflète le libellé dans le bouton.
//   5. L'option "vide" (— Aucune —) de l'adresse est présente.
//
// Aucun record n'est créé (la modale n'est jamais soumise) → pas de cleanup DB.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
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

async function apiFetch(page, path, init = {}) {
  return await page.evaluate(async ({ path, init }) => {
    const tok = localStorage.getItem('erp_token')
    const headers = Object.assign({}, init.headers || {}, { Authorization: `Bearer ${tok}` })
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('SearchableSelect — modale Nouvel envoi', () => {
  let browser, ctx, page
  let firstOrder = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const lookup = await apiFetch(page, '/api/orders/lookup')
    assert.equal(lookup.status, 200)
    assert.ok(Array.isArray(lookup.body) && lookup.body.length, 'aucune commande disponible pour le test')
    firstOrder = lookup.body[0]
  })

  after(async () => {
    await browser?.close()
  })

  test('le select commande est un SearchableSelect filtrable et sélectionnable', async () => {
    await page.goto(`${URL}/envois`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouvel envoi")')

    // 1. Le déclencheur existe et c'est bien un <button> (pas un <select> natif).
    const trigger = page.locator('[data-testid="envoi-order-select"]')
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await trigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le déclencheur doit être un bouton (SearchableSelect)')

    // 2. Ouvrir → menu en portail avec champ de recherche.
    await trigger.click()
    const menu = page.locator('[data-testid="envoi-order-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = menu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    const optionSelector = '[data-testid="envoi-order-select-menu"] button'
    const totalOptions = await page.locator(optionSelector).count()
    assert.ok(totalOptions >= 1, 'le menu devrait lister au moins une commande')

    // 3a. Filtrer sur le numéro de la première commande → au moins un résultat contenant ce numéro.
    const num = String(firstOrder.order_number)
    await searchInput.fill(num)
    await page.waitForTimeout(150)
    const matchBtn = page.locator(optionSelector, { hasText: `#${num}` }).first()
    await matchBtn.waitFor({ state: 'visible', timeout: 3000 })

    // 3b. Une requête absurde → "Aucun résultat".
    await searchInput.fill('zzz-aucune-commande-zzz-' + Date.now())
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Re-filtrer puis choisir l'option → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill(num)
    await page.waitForTimeout(150)
    await page.locator(optionSelector, { hasText: `#${num}` }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })
    const triggerText = await trigger.innerText()
    assert.ok(triggerText.includes(`#${num}`), `le bouton devrait afficher la commande choisie, got: "${triggerText}"`)
  })

  test('le select adresse expose une option vide "— Aucune —"', async () => {
    // La modale est encore ouverte depuis le test précédent ; sinon, rouvrir.
    const addrTrigger = page.locator('[data-testid="envoi-address-select"]')
    if (!(await addrTrigger.isVisible().catch(() => false))) {
      await page.goto(`${URL}/envois`, { waitUntil: 'networkidle' })
      await page.click('button:has-text("Nouvel envoi")')
    }
    await addrTrigger.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await addrTrigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le déclencheur adresse doit être un bouton (SearchableSelect)')

    await addrTrigger.click()
    const menu = page.locator('[data-testid="envoi-address-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    await menu.locator('input').waitFor({ state: 'visible' })
    // L'option vide configurée via emptyOption doit être listée.
    await menu.locator('text=— Aucune —').first().waitFor({ state: 'visible', timeout: 3000 })
  })
})
