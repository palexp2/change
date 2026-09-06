// Travaux → le champ « Titre » a été retiré du composeur de nouveau prompt :
// le titre est déduit automatiquement du prompt côté serveur, l'afficher à la
// création n'apportait rien. Il reste modifiable après coup sur la carte.
//
// Sécurité : la liste des prompts est entièrement interceptée (une carte factice
// en pause), et la création est court-circuitée avant d'atteindre le serveur —
// aucun record réel n'est écrit.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const CARD = {
  id: 'e2e-no-title-field', title: 'E2E carte factice — pas de champ titre',
  prompt: 'Ne rien faire — carte factice E2E.',
  mode: 'implement', preset: 'auto', preset_auto: 1, same_context: 0, stop_after: 0,
  status: 'paused', run_state: null, pending_question: null, user_summary: null,
  agent_status: null, lane: 'exec', wait_rank: null, follow_up: 0, space: 'finance',
  created_at: '2026-08-16T00:00:00.000Z', started_at: null, completed_at: null,
  messages: [], position: 1,
}

describe('Travaux — champ titre retiré du composeur', () => {
  let browser, ctx, page
  let createBody = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    await page.route('**/api/travaux/prompts*', async (route) => {
      const req = route.request()
      if (req.method() === 'POST') {
        createBody = req.postDataJSON()
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) })
      }
      if (req.method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [CARD], agent_enabled: true, runner_busy: false,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
    await page.route('**/api/travaux/prompts/e2e-*', async (route) => {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CARD) })
    })

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('composeur : aucun champ « Titre »', async () => {
    await page.click('[data-testid="travaux-new-prompt"]')
    await page.waitForSelector('textarea[placeholder*="terminal"]', { timeout: 5000 })
    // Le composeur = le bloc qui porte directement la zone de saisie du prompt.
    const composer = page.locator('div:has(> textarea[placeholder*="terminal"])').first()
    assert.equal(await composer.locator('input[placeholder*="Titre"]').count(), 0)
    assert.equal(await page.locator('input[placeholder*="titre automatique"]').count(), 0)
  })

  test('création : le prompt part sans titre, le serveur le déduira', async () => {
    await page.fill('textarea[placeholder*="terminal"]', 'Test E2E — titre déduit automatiquement.')
    await page.click('button:has-text("Ajouter à la file")')
    await page.waitForTimeout(500)
    assert.ok(createBody, 'la création aurait dû être envoyée au serveur')
    assert.equal(createBody.title, undefined)
    assert.equal(createBody.prompt, 'Test E2E — titre déduit automatiquement.')
  })

  test('carte existante : le titre reste modifiable après coup', async () => {
    const titleInput = page.locator(`[data-prompt-id="${CARD.id}"] input[placeholder*="Titre"]`)
    await titleInput.first().waitFor({ timeout: 5000 })
    assert.equal(await titleInput.count(), 1)
    assert.equal(await titleInput.inputValue(), CARD.title)
  })
})
