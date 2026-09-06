// SerialAccountingRules — les <select> natifs comptes débit/crédit ont été
// remplacés par le composant SearchableSelect (règle de design CLAUDE.md
// « dropdowns avec recherche » : tout dropdown >10 options doit être filtrable).
//
// Vérifie sur la modale "Nouvelle règle" (/comptabilite/regles-serials) que :
//   1. Les déclencheurs débit/crédit sont des <button> (testId) et non des <select> natifs.
//   2. Cliquer ouvre un menu en portail avec un champ de recherche.
//   3. Taper filtre les options en direct (et "Aucun résultat" si rien ne matche).
//   4. Choisir une option referme le menu et reflète le libellé dans le bouton.
//
// La modale n'est jamais soumise → aucun record créé → pas de cleanup DB.

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

describe('SerialAccountingRules — SearchableSelect comptes débit/crédit', () => {
  let browser, ctx, page
  let accounts = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const res = await apiFetch(page, '/api/connectors/quickbooks/accounts?all=1')
    assert.equal(res.status, 200, 'comptes QuickBooks inaccessibles')
    assert.ok(Array.isArray(res.body) && res.body.length > 10, 'le plan comptable devrait dépasser 10 comptes (sinon la règle ne s\'applique pas)')
    accounts = res.body
  })

  after(async () => {
    await browser?.close()
  })

  test('débit/crédit sont des SearchableSelect filtrables et sélectionnables', async () => {
    await page.goto(`${URL}/comptabilite/regles-serials`, { waitUntil: 'networkidle' })

    // Ouvrir la modale "Nouvelle règle".
    const newBtn = page.locator('button:has-text("Nouvelle règle")')
    await newBtn.waitFor({ state: 'visible', timeout: 10000 })
    await newBtn.click()

    // 1. Les déclencheurs existent et sont des <button> (pas des <select> natifs).
    const debit = page.locator('[data-testid="debit-account-select"]')
    const credit = page.locator('[data-testid="credit-account-select"]')
    await debit.waitFor({ state: 'visible', timeout: 10000 })
    await credit.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await debit.evaluate(el => el.tagName.toLowerCase()), 'button', 'le déclencheur débit doit être un bouton')
    assert.equal(await credit.evaluate(el => el.tagName.toLowerCase()), 'button', 'le déclencheur crédit doit être un bouton')

    // 2. Ouvrir le menu débit → champ de recherche présent.
    await debit.click()
    const debitMenu = page.locator('[data-testid="debit-account-select-menu"]')
    await debitMenu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = debitMenu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    const optionSelector = '[data-testid="debit-account-select-menu"] > div:last-child > button'
    const totalOptions = await page.locator(optionSelector).count()
    assert.ok(totalOptions >= 1, 'le menu devrait lister au moins un compte')

    // 3. Filtrer : choisir un fragment du libellé du premier compte.
    const first = accounts[0]
    const label = `${first.FullyQualifiedName || first.Name}`
    const frag = label.slice(0, Math.min(4, label.length))
    await searchInput.fill(frag)
    await page.waitForTimeout(250)
    const filteredCount = await page.locator(optionSelector).count()
    assert.ok(filteredCount >= 1, `le filtre "${frag}" devrait laisser au moins un compte`)
    assert.ok(filteredCount <= totalOptions, 'le filtre ne devrait pas augmenter le nombre d\'options')

    // Filtre sans résultat → "Aucun résultat".
    await searchInput.fill('zzz-aucun-compte-xyz-9999')
    await page.waitForTimeout(250)
    await debitMenu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Re-filtrer puis sélectionner → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill(frag)
    await page.waitForTimeout(250)
    const target = page.locator(optionSelector).first()
    const chosenText = (await target.innerText()).trim()
    await target.click()
    await debitMenu.waitFor({ state: 'hidden', timeout: 5000 })
    const btnText = (await debit.innerText()).trim()
    assert.ok(btnText.length > 0 && btnText !== '— Choisir —', 'le bouton débit devrait afficher le compte choisi')
    assert.ok(chosenText.includes(btnText) || btnText.includes(chosenText.split('(')[0].trim()), 'le libellé du bouton devrait correspondre au compte sélectionné')

    // Le menu crédit fonctionne aussi (smoke) : fermer le menu en cliquant ailleurs
    // (Escape bulle jusqu'à la modale et la fermerait entièrement).
    await credit.click()
    const creditMenu = page.locator('[data-testid="credit-account-select-menu"]')
    await creditMenu.waitFor({ state: 'visible', timeout: 5000 })
    await creditMenu.locator('input').waitFor({ state: 'visible' })
    await page.locator('label:has-text("Compte crédit")').click()
    await creditMenu.waitFor({ state: 'hidden', timeout: 5000 })

    // La modale n'est jamais soumise — fermer sans créer de règle.
    const cancel = page.locator('button:has-text("Annuler")')
    await cancel.waitFor({ state: 'visible', timeout: 5000 })
    await cancel.click()
  })
})
