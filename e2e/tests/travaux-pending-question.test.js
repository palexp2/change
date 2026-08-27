// Travaux — question de Claude à répondre depuis l'ERP.
//
// Une exécution de l'agent tourne détachée, sans terminal : quand une décision ne
// lui appartient pas, elle pose sa question sur l'item de file (colonne
// pending_question) et la carte l'affiche avec ses choix. Ce test vérifie le rendu
// et le fait qu'un clic envoie bien la réponse.
//
// La liste ET la réponse sont INTERCEPTÉES : rien n'est écrit en base et le POST de
// réponse n'atteint jamais le serveur — sinon il relancerait une vraie exécution de
// l'agent (Claude détaché sur le repo de prod). Aucun record réel n'est touché.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FAKE = {
  id: 'e2e-pending-question',
  title: 'E2E question à répondre',
  prompt: 'Trie les achats.',
  status: 'done',
  position: 1,
  mode: 'implement',
  preset: 'deep',
  same_context: 0,
  title_auto: 0,
  created_at: '2026-08-04T00:00:00.000Z',
  started_at: '2026-08-04T00:00:00.000Z',
  completed_at: '2026-08-04T00:05:00.000Z',
  user_summary: null,
  agent_status: 'done',
  run_state: null,
  lane: 'exec',
  wait_rank: null,
  pending_question: {
    question: 'Trier par date ou par montant ?',
    options: ['Par date de facture', 'Par montant décroissant'],
  },
  messages: [{
    id: 'e2e-msg-1',
    prompt_id: 'e2e-pending-question',
    role: 'agent',
    text: 'J\'ai préparé le tri.\n\n❓ Trier par date ou par montant ?',
    created_at: '2026-08-04T00:05:00.000Z',
  }],
}

describe('Travaux — question en attente', () => {
  let browser, ctx, page
  let replyBody = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // La liste renvoie UNIQUEMENT l'item factice : la page reste lisible et le test
    // ne dépend pas de l'état réel de la file.
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            prompts: [FAKE], agent_enabled: true, runner_busy: false,
            running_questions: 0, max_parallel_questions: 2,
          }),
        })
      }
      return route.continue()
    })
    // Réponse capturée puis court-circuitée : atteindre le serveur relancerait une
    // vraie exécution de l'agent.
    await page.route('**/api/travaux/prompts/*/reply', async (route) => {
      replyBody = route.request().postDataJSON()
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ ...FAKE, status: 'running', pending_question: null }),
      })
    })
  })

  after(async () => { await browser?.close() })

  test('la carte affiche la question, ses choix, et sort de l\'historique', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Travaux")', { timeout: 10000 })

    const card = page.locator('[data-prompt-id="e2e-pending-question"]')
    await card.waitFor({ timeout: 10000 })
    // Pastille « À répondre » plutôt que « Terminé » : le travail n'est pas fini,
    // il attend une décision humaine.
    await assert.doesNotReject(card.locator('text=À répondre').first().waitFor({ timeout: 5000 }))
    await assert.doesNotReject(card.locator('[data-testid="travaux-question"]').waitFor({ timeout: 5000 }))
    // La question elle-même vit dans le fil (elle doit survivre à la réponse).
    await assert.doesNotReject(card.locator('text=Trier par date ou par montant').first().waitFor({ timeout: 5000 }))

    const options = card.locator('[data-testid="travaux-question-option"]')
    assert.equal(await options.count(), 2, 'les deux choix doivent être proposés')

    // Hors de la section « Terminés » : la carte est dans la file active.
    const inHistory = await page.evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('Terminés'))
      if (!h) return false
      const card = document.querySelector('[data-prompt-id="e2e-pending-question"]')
      return !!card && h.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
    })
    assert.equal(inHistory, false, 'un item qui attend une réponse ne doit pas être rangé dans « Terminés »')
  })

  test('cliquer un choix envoie ce choix comme réponse', async () => {
    replyBody = null
    const card = page.locator('[data-prompt-id="e2e-pending-question"]')
    await card.locator('[data-testid="travaux-question-option"]').first().click()
    await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {})
    // Le POST est capturé côté route : on attend qu'il soit arrivé.
    for (let i = 0; i < 20 && !replyBody; i++) await new Promise(r => setTimeout(r, 200))
    assert.ok(replyBody, 'un clic sur un choix doit envoyer une réponse')
    assert.equal(replyBody.text, 'Par date de facture')
  })
})
