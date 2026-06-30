// GlobalSearch (Cmd+K) — fil « Récemment consultés ».
//
// Vérifie que la palette mémorise les dernières fiches détail visitées et les
// propose en tête lorsque la requête est vide, avec retour rapide au record.
//
// Test en lecture seule côté DB : on ne fait que VISITER des fiches détail
// existantes (navigation normale) et lire la palette. La seule écriture est dans
// le localStorage du contexte navigateur éphémère (clé `erp:recentRecords`),
// détruit à la fermeture du contexte — aucune pollution de la vraie DB, donc
// aucun cleanup DB requis. On efface tout de même la clé en fin de test.

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

function apiGet(page, p) {
  return page.evaluate(async ({ path }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, { path: p })
}

async function openPalette(page) {
  await page.keyboard.press('Control+k')
  await page.waitForSelector('[data-testid="global-search-input"]', { state: 'visible', timeout: 5000 })
}

async function closePalette(page) {
  // Le handler Échap est sur l'input : on le refocalise au cas où le focus
  // serait sur un bouton interne (ex. « Effacer ») avant de presser Échap.
  await page.locator('[data-testid="global-search-input"]').focus()
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="global-search-input"]', { state: 'detached', timeout: 5000 })
}

describe('GlobalSearch — récemment consultés', () => {
  let browser, ctx, page
  let companyA, companyB

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)

    // Deux entreprises réelles avec un nom non vide (records existants).
    const r = await apiGet(page, '/companies?limit=50')
    const named = (r.data || []).filter(c => c.name && c.name.trim())
    assert.ok(named.length >= 2, 'il faut au moins 2 entreprises nommées pour ce test')
    companyA = named[0]
    companyB = named[1]
  })

  after(async () => {
    // Nettoie le fil pour ne pas laisser d'état entre runs (localStorage éphémère
    // de toute façon, mais on est propre).
    try { await page.evaluate(() => localStorage.removeItem('erp:recentRecords')) } catch { /* noop */ }
    await browser?.close()
  })

  test('une fiche visitée apparaît dans « Récemment consultés » avec son vrai nom', async () => {
    // Visite la fiche détail de l'entreprise A.
    await page.goto(`${URL}/companies/${companyA.id}`, { waitUntil: 'networkidle' })

    // Retour sur une page neutre, puis ouverture de la palette à vide.
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    // Section présente.
    await page.waitForSelector('li:has-text("Récemment consultés")', { timeout: 5000 })

    // L'entrée pointe vers la fiche visitée et porte son nom live (résolu depuis
    // le dataStore), pas un libellé brut.
    const recentBtn = page.locator(`[data-testid="global-search-recent-/companies/${companyA.id}"]`)
    await recentBtn.first().waitFor({ state: 'visible', timeout: 5000 })
    const txt = await recentBtn.first().innerText()
    assert.ok(txt.includes(companyA.name), `l'entrée récente doit afficher le nom « ${companyA.name} » (vu: ${txt})`)

    await closePalette(page)
  })

  test('retour rapide : clic sur une entrée récente navigue vers la fiche', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    const recentBtn = page.locator(`[data-testid="global-search-recent-/companies/${companyA.id}"]`)
    await recentBtn.first().waitFor({ state: 'visible', timeout: 5000 })
    await recentBtn.first().click()
    await page.waitForURL(u => u.toString().includes(`/companies/${companyA.id}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/companies/${companyA.id}`), 'le clic doit ramener à la fiche entreprise')
  })

  test('le record le plus récemment visité passe en tête (dédoublonnage)', async () => {
    // Visite A puis B : B doit être en première position du fil.
    await page.goto(`${URL}/companies/${companyA.id}`, { waitUntil: 'networkidle' })
    await page.goto(`${URL}/companies/${companyB.id}`, { waitUntil: 'networkidle' })
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    await page.waitForSelector('li:has-text("Récemment consultés")', { timeout: 5000 })
    const firstRecent = page.locator('[data-testid^="global-search-recent-"]').first()
    await firstRecent.waitFor({ state: 'visible', timeout: 5000 })
    const testid = await firstRecent.getAttribute('data-testid')
    assert.equal(testid, `global-search-recent-/companies/${companyB.id}`,
      'la dernière fiche visitée (B) doit être en tête du fil')

    await closePalette(page)
  })

  test('« Effacer » vide le fil', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await openPalette(page)

    await page.waitForSelector('li:has-text("Récemment consultés")', { timeout: 5000 })
    await page.locator('[data-testid="global-search-clear-recent"]').click()

    // La section disparaît (plus de récents).
    await page.waitForSelector('li:has-text("Récemment consultés")', { state: 'detached', timeout: 5000 })
    const anyRecent = await page.locator('[data-testid^="global-search-recent-"]').count()
    assert.equal(anyRecent, 0, 'aucune entrée récente ne doit subsister après Effacer')

    await closePalette(page)
  })
})
