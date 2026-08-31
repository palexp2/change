// FAB « Modifier le système » — la fenêtre se referme SANS attendre le serveur.
//
// Avant : le clic sur « Envoyer » attendait la réponse du POST (et, serveur
// occupé, les rafraîchissements temps réel déclenchés dans la foulée) — la
// modale restait figée sur « Envoi… » une demi-seconde ou plus.
// Après : la fenêtre se referme au clic, l'envoi finit en arrière-plan, le toast
// accuse réception à la réponse, et un échec rouvre la fenêtre avec le brouillon
// intact.
//
// IMPORTANT — aucune mutation réelle : le POST /travaux/prompts est INTERCEPTÉ
// (page.route), il n'atteint jamais le serveur. Aucun item déposé, aucun agent
// lancé (prod DB = test DB, voir CLAUDE.md). Rien à nettoyer.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Retard imposé à la réponse du serveur : largement au-dessus de tout délai de
// rendu, pour que « la modale s'est fermée avant la réponse » ne soit pas un
// hasard de chronométrage.
const SERVER_DELAY_MS = 4000

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

describe('FAB « Modifier le système » — fermeture instantanée', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await browser?.close()
  })

  test('« Envoyer » referme la fenêtre avant même la réponse du serveur', async () => {
    await page.goto(URL + '/champs/projects', { waitUntil: 'domcontentloaded' })

    let responded = false
    await page.route(/\/erp\/api\/travaux\/prompts(\?|$)/, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      await new Promise(r => setTimeout(r, SERVER_DELAY_MS))
      responded = true
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'e2e-fake', status: 'queued', space: 'agent' }),
      })
    })

    await page.click('[data-testid="feedback-fab"]')
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ timeout: 10000 })
    await textarea.fill(`E2E fermeture instantanée ${Date.now()} : ne rien faire.`)

    const t0 = Date.now()
    await page.click('[data-testid="feedback-fab-submit"]')
    await textarea.waitFor({ state: 'detached', timeout: SERVER_DELAY_MS - 1000 })
    const elapsed = Date.now() - t0

    // Le contrat, indépendant du chronomètre : la fenêtre est partie alors que
    // le serveur n'avait pas encore répondu.
    assert.equal(responded, false,
      `la modale doit se fermer avant la réponse du serveur (fermée en ${elapsed} ms)`)
    assert.equal(await page.locator('[role="dialog"]').count(), 0, 'la modale doit être fermée')

    // Le toast accuse réception quand la réponse arrive, sans rien bloquer.
    await page.locator('text=/file de l\'Agent|tout de suite/').first().waitFor({ timeout: 10000 })
    assert.equal(responded, true, 'le POST doit bien avoir été émis vers le serveur')

    await page.unroute(/\/erp\/api\/travaux\/prompts(\?|$)/)
  })

  test('envoi échoué : la fenêtre revient avec le brouillon intact', async () => {
    const draft = `E2E envoi échoué ${Date.now()} : ne rien faire.`

    await page.route(/\/erp\/api\/travaux\/prompts(\?|$)/, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'panne simulée' }),
      })
    })

    await page.click('[data-testid="feedback-fab"]')
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ timeout: 10000 })
    await textarea.fill(draft)
    await page.click('[data-testid="feedback-fab-submit"]')

    // La fenêtre revient d'elle-même, avec exactement ce qui était écrit.
    await page.locator('[data-testid="feedback-fab-text"]').waitFor({ timeout: 10000 })
    await page.waitForFunction(
      expected => document.querySelector('[data-testid="feedback-fab-text"]')?.value === expected,
      draft,
      { timeout: 10000 },
    )
    await page.locator('text=/Échec de l\'envoi/').first().waitFor({ timeout: 10000 })

    // On repart d'une modale fermée et d'un brouillon vidé pour ne rien laisser
    // derrière (le brouillon vit en sessionStorage, propre à l'onglet).
    await page.fill('[data-testid="feedback-fab-text"]', '')
    await page.keyboard.press('Escape')
    await page.unroute(/\/erp\/api\/travaux\/prompts(\?|$)/)
  })
})
