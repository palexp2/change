const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la position de scroll vertical de la page Relance Qualification
// est restaurée après un rafraîchissement de la page (sessionStorage).
//
// Pas de cleanup nécessaire : on ne crée aucun record en DB, on touche
// uniquement à sessionStorage côté navigateur (vidé à la fermeture du contexte).
describe('RelanceQualification — persistance du scroll', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  test('scroll vertical restauré après reload', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'networkidle' })
    await page.locator('article').first().waitFor({ timeout: 8000 })

    // S'assure qu'il y a assez de contenu pour scroller (sinon le test n'a
    // pas de sens). On exige au moins 2 cartes.
    const cardCount = await page.locator('article').count()
    if (cardCount < 2) {
      console.warn(`[scroll-persistence] Pas assez de cartes (${cardCount}) pour tester le scroll, skip.`)
      return
    }

    // Cible : la position de la 2e carte. On utilise le scroll du <main>
    // (overflow-y: auto), pas du window.
    const targetY = await page.evaluate(() => {
      const main = document.querySelector('main')
      const articles = document.querySelectorAll('article')
      if (!main || articles.length < 2) return 0
      const mainRect = main.getBoundingClientRect()
      const secondRect = articles[1].getBoundingClientRect()
      const offset = secondRect.top - mainRect.top + main.scrollTop
      main.scrollTop = offset
      return main.scrollTop
    })
    assert.ok(targetY > 50, `targetY trop faible (${targetY}) — le scroll ne suit peut-être pas le <main>`)

    // Laisse le listener "scroll" écrire dans sessionStorage (rAF + flush)
    await page.waitForTimeout(150)

    const stored = await page.evaluate(() => sessionStorage.getItem('erp.relanceQualif.scroll'))
    assert.ok(stored !== null, 'sessionStorage devrait contenir la position de scroll')
    const storedY = parseInt(stored, 10)
    assert.ok(Math.abs(storedY - targetY) < 5,
      `sessionStorage (${storedY}) doit être proche du scrollTop courant (${targetY})`)

    // Reload : la position doit être restaurée (avec tolérance car les
    // textareas s'auto-redimensionnent — le code retente plusieurs fois).
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('article').first().waitFor({ timeout: 8000 })

    // Attente active : le code de restauration retente jusqu'à 1s.
    let restoredY = 0
    for (let i = 0; i < 30; i++) {
      restoredY = await page.evaluate(() => document.querySelector('main')?.scrollTop || 0)
      if (Math.abs(restoredY - targetY) < 10) break
      await page.waitForTimeout(50)
    }
    assert.ok(Math.abs(restoredY - targetY) < 10,
      `Après reload, scrollTop attendu ~${targetY}, observé ${restoredY}`)
  })
})
