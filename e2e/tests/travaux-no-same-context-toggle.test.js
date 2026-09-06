// Travaux → la case « Poursuit le contexte du précédent » a été retirée du
// composeur et de l'édition d'une carte : chaque nouveau prompt part toujours
// avec un contexte neuf, la vraie continuité (réponse, relance fauchée) étant
// gérée automatiquement ailleurs (`follow_up`), pas par un choix manuel.
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
  id: 'e2e-no-same-context', title: 'E2E carte factice — pas de case même contexte',
  prompt: 'Ne rien faire — carte factice E2E.',
  mode: 'implement', preset: 'deep', preset_auto: 0, same_context: 0, stop_after: 0,
  status: 'paused', run_state: null, pending_question: null, user_summary: null,
  agent_status: null, lane: 'exec', wait_rank: null, follow_up: 0, space: 'finance',
  created_at: '2026-08-04T00:00:00.000Z', started_at: null, completed_at: null,
  messages: [], position: 1,
}

describe('Travaux — case « Poursuit le contexte du précédent » retirée', () => {
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

    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('composeur : aucune case « Poursuit le contexte du précédent »', async () => {
    await page.click('[data-testid="travaux-new-prompt"]')
    const toggle = page.locator('label:has-text("Poursuit le contexte du précédent")')
    assert.equal(await toggle.count(), 0)
  })

  test('création : le prompt part sans same_context, avec un contexte neuf', async () => {
    await page.fill('textarea[placeholder*="terminal"]', 'Test E2E — pas de continuité de contexte.')
    await page.click('button:has-text("Ajouter à la file")')
    await page.waitForTimeout(500)
    assert.ok(createBody, 'la création aurait dû être envoyée au serveur')
    assert.equal(createBody.same_context, undefined)
  })

  test('carte existante : aucune case d\'édition « Poursuit le contexte »', async () => {
    await page.click(`[data-prompt-id="${CARD.id}"] [data-testid="travaux-toggle"]`)
    const toggle = page.locator('label:has-text("Poursuit le contexte du précédent")')
    assert.equal(await toggle.count(), 0)
  })
})
