// Travaux : la recherche doit chercher simultanément dans la file ET dans les
// conversations, et afficher les résultats des deux sections en même temps —
// peu importe l'onglet ouvert au moment de la frappe. Fixture entièrement
// interceptée (aucune écriture réelle en base).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const base = {
  space: 'finance', mode: 'implement', preset: 'deep', same_context: 0, title_auto: 0,
  stop_after: 0, pending_question: null, user_summary: null, agent_status: null,
  lane: 'exec', run_state: null, wait_rank: null, messages: [],
}
const QUEUED_ONE = {
  ...base, id: 'e2e-search-queued', title: 'E2E zébrure queue',
  prompt: 'Corriger la zébrure du tableau.', status: 'queued', position: 1,
  created_at: '2026-08-09T00:00:00.000Z',
}
const DONE_ONE = {
  ...base, id: 'e2e-search-done', title: 'E2E zébrure terminée',
  prompt: 'Zébrure déjà corrigée.', status: 'done', position: 2,
  created_at: '2026-08-01T00:00:00.000Z', started_at: '2026-08-01T00:00:00.000Z',
  completed_at: '2026-08-01T10:00:00.000Z',
}
const OTHER_ONE = {
  ...base, id: 'e2e-search-other', title: 'E2E sans rapport',
  prompt: 'Tâche complètement différente.', status: 'queued', position: 3,
  created_at: '2026-08-09T00:01:00.000Z',
}

describe('Travaux — la recherche couvre file + conversations', () => {
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

    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [QUEUED_ONE, DONE_ONE, OTHER_ONE], agent_enabled: true, runner_busy: false,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-prompt-id="e2e-search-queued"]').waitFor({ timeout: 15000 })
  })

  after(async () => {
    await page?.unroute('**/api/travaux/prompts*').catch(() => {})
    await browser?.close()
  })

  test('taper une recherche affiche les deux sections avec leurs résultats respectifs', async () => {
    await page.locator('[data-testid="travaux-search"]').fill('zébrure')

    // Le résultat en file ET le résultat en conversations doivent être visibles
    // en même temps, sans avoir à cliquer sur l'onglet Conversations.
    await page.locator('[data-prompt-id="e2e-search-queued"]').waitFor({ timeout: 5000 })
    await page.locator('[data-prompt-id="e2e-search-done"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator('[data-prompt-id="e2e-search-other"]').count(), 0,
      'l\'item sans rapport avec la recherche ne doit pas apparaître')
  })

  test('vider la recherche restaure la vue par onglet unique', async () => {
    await page.locator('[data-testid="travaux-search"]').fill('')
    // Onglet File actif : la conversation terminée ne doit plus être affichée.
    await page.locator('[data-prompt-id="e2e-search-queued"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator('[data-prompt-id="e2e-search-done"]').count(), 0,
      'hors recherche, l\'onglet File ne doit montrer que la file')
  })
})
