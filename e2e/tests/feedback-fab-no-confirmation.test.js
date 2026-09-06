// FAB « Modifier le système » — l'envoi n'a plus d'étape de confirmation.
//
// Vérifie qu'après un clic sur « Envoyer » : la modale se referme d'elle-même,
// l'écran « Ajouté à la fin de ta file Travaux… » n'existe plus, un simple toast
// accuse réception, et le brouillon est vidé (réouvrir la bulle donne un champ
// vierge).
//
// IMPORTANT — aucune mutation réelle : le POST /travaux/prompts est INTERCEPTÉ
// (page.route) et satisfait par une 201 factice ; la requête n'atteint jamais le
// serveur, donc aucun item n'est déposé et aucun agent n'est lancé (prod DB =
// test DB, voir CLAUDE.md). Rien à nettoyer.

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

describe('FAB feedback — envoi sans étape de confirmation', () => {
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

  test('« Envoyer » dépose la demande et referme la fenêtre', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })

    let captured = null
    await page.route(/\/erp\/api\/travaux\/prompts(\?|$)/, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      captured = route.request().postDataJSON()
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'e2e-fake', prompt: captured?.prompt, status: 'queued', space: 'finance' }),
      })
    })

    await page.click('[data-testid="feedback-fab"]')
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ timeout: 5000 })
    const text = `E2E sans confirmation ${Date.now()} : ne rien faire.`
    await textarea.fill(text)
    await page.click('[data-testid="feedback-fab-submit"]')

    // 1. La fenêtre se referme toute seule.
    await textarea.waitFor({ state: 'detached', timeout: 10000 })
    assert.equal(await page.locator('[role="dialog"]').count(), 0, 'la modale doit être fermée')

    // 2. L'étape de confirmation n'existe plus.
    assert.equal(await page.locator('[data-testid="feedback-approved"]').count(), 0,
      'l\'écran « Ajouté à la fin de ta file Travaux… » a été retiré')

    // 3. La demande est bien partie (contrat de la requête).
    assert.ok(captured, 'un POST /travaux/prompts doit avoir été émis')
    assert.ok(String(captured.prompt || '').includes(text), 'le texte saisi doit être envoyé')

    // 4. Un toast accuse réception, sans bloquer.
    await page.locator('text=/file de l\'Agent|tout de suite/').first().waitFor({ timeout: 10000 })

    // 5. Le brouillon est vidé : rouvrir la bulle donne un champ vierge.
    await page.click('[data-testid="feedback-fab"]')
    await textarea.waitFor({ timeout: 5000 })
    assert.equal(await textarea.inputValue(), '', 'le champ doit être vierge à la réouverture')
    await page.keyboard.press('Escape')
  })
})
