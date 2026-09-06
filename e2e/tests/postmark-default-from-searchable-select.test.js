// PostmarkConfig — le <select> natif de l'« Adresse expéditeur par défaut » a été
// remplacé par le composant SearchableSelect (règle de design CLAUDE.md
// « dropdowns avec recherche » : tout dropdown susceptible d'offrir >10 options
// doit être filtrable). Le nombre de signatures @orisha.io (users actifs + alias)
// peut facilement dépasser 10.
//
// Vérifie sur /connectors (carte Postmark dépliée) que :
//   1. Le picker adresse est un <button> (testId) et non un <select> natif.
//   2. Cliquer ouvre un menu en portail avec un champ de recherche.
//   3. Taper filtre les options en direct (et "Aucun résultat" si rien ne matche).
//   4. Choisir une adresse referme le menu, reflète le libellé dans le bouton,
//      puis « Enregistrer » la persiste (vérifié via l'API).
//
// La config « default_from » est une préférence EXISTANTE : on lit sa valeur
// courante avant le test et on la restaure dans after() (règle CLAUDE.md
// « sauvegarder/restaurer les configurations écrasées par les tests E2E »).

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
    const headers = Object.assign(
      {}, init.headers || {}, { Authorization: `Bearer ${tok}` },
      init.body ? { 'Content-Type': 'application/json' } : {}
    )
    const r = await fetch('/erp' + path, { ...init, headers })
    const text = await r.text()
    try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
  }, { path, init })
}

describe('PostmarkConfig — SearchableSelect adresse expéditeur par défaut', () => {
  let browser, ctx, page
  let addresses = []
  let originalDefaultFrom // null si aucun défaut

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    const res = await apiFetch(page, '/api/connectors/postmark')
    assert.equal(res.status, 200, 'infos Postmark inaccessibles')
    addresses = res.body.addresses
    originalDefaultFrom = res.body.default_from ?? null
    assert.ok(Array.isArray(addresses) && addresses.length >= 2,
      `il faut au moins 2 adresses pour tester le filtrage, got ${addresses.length}`)
  })

  after(async () => {
    // Restaure toujours le défaut original, même si le test a échoué.
    if (page) {
      await apiFetch(page, '/api/connectors/postmark/default', {
        method: 'PUT',
        body: JSON.stringify({ default_from: originalDefaultFrom }),
      })
    }
    await browser?.close()
  })

  test('le picker est un SearchableSelect filtrable, sélectionnable et persistant', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    // Déplier la carte du connecteur Postmark.
    await page.locator('button:has-text("Postmark")').first().click()

    // 1. Le picker est un <button> (pas un <select> natif).
    const trigger = page.locator('[data-testid="postmark-default-from-select"]')
    await trigger.waitFor({ state: 'visible', timeout: 10000 })
    const tag = await trigger.evaluate(el => el.tagName.toLowerCase())
    assert.equal(tag, 'button', 'le picker adresse doit être un bouton (SearchableSelect)')

    // 2. Ouvrir → menu en portail avec champ de recherche.
    await trigger.click()
    const menu = page.locator('[data-testid="postmark-default-from-select-menu"]')
    await menu.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = menu.locator('input')
    await searchInput.waitFor({ state: 'visible' })

    // Le menu liste l'option vide « — Aucun — » + chaque adresse.
    const optionSelector = '[data-testid="postmark-default-from-select-menu"] button'
    const totalOptions = await page.locator(optionSelector).count()
    assert.ok(totalOptions >= addresses.length + 1,
      `le menu devrait lister l'option vide + ${addresses.length} adresses, got ${totalOptions}`)

    // 3a. Filtrer sur le début de la première adresse → liste restreinte.
    const target = addresses[0]
    await searchInput.fill(target.slice(0, 4))
    await page.waitForTimeout(150)
    const filteredCount = await page.locator(optionSelector).count()
    assert.ok(filteredCount >= 1 && filteredCount < totalOptions,
      'le filtre devrait restreindre la liste')

    // 3b. Requête absurde → « Aucun résultat ».
    await searchInput.fill('zzz-aucune-adresse-zzz-' + Date.now())
    await page.waitForTimeout(150)
    await menu.locator('text=Aucun résultat').waitFor({ state: 'visible', timeout: 3000 })

    // 4. Re-filtrer, choisir l'adresse → menu fermé + libellé reflété dans le bouton.
    await searchInput.fill(target)
    await page.waitForTimeout(150)
    await page.locator(optionSelector, { hasText: target }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 3000 })
    const triggerText = (await trigger.innerText()).trim()
    assert.ok(triggerText.includes(target),
      `le bouton devrait afficher l'adresse choisie, got "${triggerText}"`)

    // 5. Enregistrer → persistance vérifiée via l'API.
    await page.locator('button:has-text("Enregistrer")').first().click()
    await page.waitForTimeout(500)
    const after = await apiFetch(page, '/api/connectors/postmark')
    assert.equal(after.status, 200)
    assert.equal(after.body.default_from, target,
      'le défaut sauvegardé devrait être l\'adresse choisie')
  })
})
