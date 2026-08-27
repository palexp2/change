// FAB « Modifier le système » monté dans Layout.
//
// Vérifie : le bouton flottant est présent sur une page quelconque, son clic
// ouvre directement la modale, et la soumission émet un POST
// /api/travaux/prompts (destination unique : la file de la section Travaux)
// avec la route courante jointe au prompt, puis la modale se referme (aucun
// écran de confirmation).
//
// IMPORTANT — aucune mutation réelle : le POST /travaux/prompts est INTERCEPTÉ
// (page.route) et satisfait par une réponse 201 factice ; la requête n'atteint
// jamais le serveur. Une vraie soumission dépose un item dans la file et relance
// l'ordonnanceur, ce qui peut lancer un vrai process Claude en prod (prod DB =
// test DB, voir CLAUDE.md « E2E : ne jamais muter un vrai record »). On vérifie
// donc le CONTRAT de la requête (texte + contexte) sans aucun effet de bord —
// rien à nettoyer.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E feedback FAB ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('FAB feedback → file Travaux', () => {
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

  test('le FAB ouvre la modale, envoie à la file avec la route en contexte', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Intercepte le POST /travaux/prompts : on capture le corps et on répond une
    // 201 factice sans laisser la requête atteindre le serveur (aucun item réel
    // créé, aucune exécution d'agent déclenchée). Les GET de la file (panneau
    // rapide, page Travaux) passent normalement.
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

    // Le FAB est présent sur la page.
    const fab = page.locator('[data-testid="feedback-fab"]')
    await fab.waitFor({ timeout: 10000 })
    await fab.click()

    // Le FAB ouvre directement la modale (demande générale par défaut, aucun
    // élément ciblé — le ciblage reste accessible depuis le formulaire).
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ timeout: 5000 })
    await textarea.fill(MARKER)
    await page.locator('[data-testid="feedback-fab-submit"]').click()

    // Plus d'écran de confirmation : la réponse 201 factice referme la modale.
    await textarea.waitFor({ state: 'detached', timeout: 5000 })

    // Le contrat de la requête : le texte saisi + la route courante en contexte,
    // dans la file de la section Travaux.
    assert.ok(captured, 'un POST /travaux/prompts doit avoir été émis')
    assert.ok(String(captured.prompt || '').includes(MARKER), 'le texte saisi doit être envoyé dans le prompt')
    assert.equal(captured.space, 'finance', 'la demande part dans la file de la section Travaux')
    assert.ok(
      String(captured.prompt || '').includes('/dashboard'),
      'la route courante /dashboard doit être jointe en contexte',
    )
  })
})
