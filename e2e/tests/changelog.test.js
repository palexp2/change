// Changelog / Nouveautés — page in-app alimentée par un fichier versionné.
//
// Couvre :
//  1. La page /changelog s'affiche avec son titre et au moins une entrée.
//  2. Le menu utilisateur (hover avatar) expose un lien « Nouveautés ».
//  3. La pastille « nouveautés » apparaît quand il y a des entrées non vues
//     (localStorage vide) puis disparaît après consultation de la page.
//
// Aucun record DB n'est créé ni muté — la page lit un JSON versionné côté
// client. Le seul état est localStorage (`erp.changelog.lastSeen`), éphémère :
// il meurt avec le contexte navigateur fermé dans after(). Rien à restaurer.

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

describe('Changelog — page Nouveautés', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('la page /changelog affiche le titre et au moins une entrée', async () => {
    await page.goto(URL + '/changelog', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Nouveautés")', { timeout: 10000 })

    // Au moins une entrée de changelog (h2 = titre d'entrée).
    const entryCount = await page.locator('main h2').count()
    assert.ok(entryCount >= 1, `attendu ≥1 entrée, obtenu ${entryCount}`)

    // Au moins une étiquette de type (Nouveau / Amélioration / Correction).
    const badgeText = await page.locator('main').innerText()
    assert.ok(
      /Nouveau|Amélioration|Correction/.test(badgeText),
      'au moins une étiquette de type attendue dans le journal'
    )
  })

  test('le menu utilisateur expose un lien « Nouveautés »', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.hover('[data-testid="user-avatar-trigger"]')
    const link = page.locator('[data-testid="user-menu-changelog"]')
    await link.waitFor({ state: 'visible', timeout: 5000 })
    await link.click()
    await page.waitForURL(u => u.toString().includes('/changelog'), { timeout: 10000 })
    await page.waitForSelector('h1:has-text("Nouveautés")', { timeout: 10000 })
  })

  test('la pastille apparaît si non vu, puis disparaît après consultation', async () => {
    // Forcer l'état « jamais vu » : vider la clé lastSeen et recharger.
    await page.evaluate(() => localStorage.removeItem('erp.changelog.lastSeen'))
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Pastille présente sur l'avatar.
    const badge = page.locator('[data-testid="changelog-badge"]')
    await badge.waitFor({ state: 'visible', timeout: 5000 })

    // Consulter la page Changelog → marque comme lu.
    await page.goto(URL + '/changelog', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Nouveautés")', { timeout: 10000 })

    // lastSeen doit maintenant être renseigné.
    const lastSeen = await page.evaluate(() => localStorage.getItem('erp.changelog.lastSeen'))
    assert.ok(lastSeen && /^\d{4}-\d{2}-\d{2}$/.test(lastSeen), `lastSeen attendu YYYY-MM-DD, obtenu ${lastSeen}`)

    // Revenir au dashboard → pastille disparue.
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    const stillThere = await page.locator('[data-testid="changelog-badge"]').count()
    assert.equal(stillThere, 0, 'la pastille doit disparaître après consultation')
  })
})
