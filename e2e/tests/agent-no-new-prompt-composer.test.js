// /agent — retrait du dépôt « Nouveau prompt… » de l'encart « Demandes de
// modification du système ».
//
// Cet encart réutilise la file de la page Travaux (QueueTab). Sur /agent, il ne
// sert qu'à SUIVRE la file : le dépôt d'une demande passe par le FAB « Modifier
// le système » (présent partout dans l'app) ou par /agent/travaux. Ce test
// vérifie :
//   1. le bouton « Nouveau prompt… » n'apparaît plus sur /agent ;
//   2. la file elle-même est toujours là (vues File / Conversations) ;
//   3. le dépôt reste présent sur /travaux et /agent/travaux (non-régression).
//
// Lecture seule : aucun record créé, aucun réglage touché.

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

describe('/agent — plus de dépôt « Nouveau prompt… »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('le bouton a disparu de /agent, la file reste', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Demandes de modification du système', { timeout: 20000 })
    // La file est bien montée (sinon l'absence du bouton ne prouverait rien).
    await page.waitForSelector('[data-testid="travaux-view-file"]', { timeout: 20000 })

    assert.equal(await page.locator('[data-testid="travaux-new-prompt"]').count(), 0,
      'le bouton « Nouveau prompt… » ne doit plus être rendu sur /agent')
    assert.equal(await page.locator('[data-testid="travaux-new-submit"]').count(), 0,
      'le composeur déplié ne doit pas être rendu non plus')
    assert.ok(await page.locator('[data-testid="travaux-view-conversations"]').count() > 0,
      'la file doit rester affichée (vue Conversations présente)')
  })

  test('le dépôt reste disponible sur /travaux et /agent/travaux', async () => {
    for (const path of ['/travaux?onglet=file', '/agent/travaux?onglet=file']) {
      await page.goto(URL + path, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 20000 })
      assert.equal(await page.locator('[data-testid="travaux-new-prompt"]').count(), 1,
        `le dépôt doit rester présent sur ${path}`)
    }
  })

  test('le FAB « Modifier le système » reste l\'entrée de dépôt depuis /agent', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="travaux-quick-button"]', { timeout: 20000 })
    assert.ok(await page.locator('[data-testid="travaux-quick-button"]').count() > 0,
      'le FAB doit rester accessible pour déposer une demande')
  })
})
