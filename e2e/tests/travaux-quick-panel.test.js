// Panneau rapide de la file de travaux — joignable depuis n'importe quelle page.
//
// Couvre les trois usages : déposer un prompt avec le contexte de la page
// pré-rempli (route + fiche affichée), lire l'état de la file (en cours + rangs
// numérotés), et répondre à une question de Claude sans quitter la page.
//
// TOUT EST INTERCEPTÉ : la liste est simulée (état déterministe, indépendant de la
// vraie file), la création et la réponse n'atteignent JAMAIS le serveur — sinon
// elles lanceraient une vraie exécution de l'agent sur le repo de prod. Aucun
// record réel n'est créé ni modifié : rien à nettoyer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const base = (over) => ({
  id: 'e2e-quick-x', title: 'Item', prompt: 'Ne rien faire.', status: 'queued', position: 1,
  space: 'finance', mode: 'implement', preset: 'auto', same_context: 0, title_auto: 0,
  created_at: '2026-08-09T00:00:00.000Z', started_at: null, completed_at: null,
  user_summary: null, agent_status: null, run_state: null, lane: 'exec', wait_rank: null,
  pending_question: null, messages: [], ...over,
})

const RUNNING = base({
  id: 'e2e-quick-running', title: 'E2E — tâche en cours', status: 'running',
  run_state: 'executing', started_at: '2026-08-09T00:01:00.000Z',
})
const QUEUED_1 = base({ id: 'e2e-quick-q1', title: 'E2E — premier en file', position: 2, wait_rank: 1 })
const QUEUED_2 = base({ id: 'e2e-quick-q2', title: 'E2E — deuxième en file', position: 3, wait_rank: 2 })
const ASKING = base({
  id: 'e2e-quick-asking', title: 'E2E — question à répondre', status: 'done',
  completed_at: '2026-08-09T00:02:00.000Z', agent_status: 'done',
  pending_question: { question: 'Trier par date ou par montant ?', options: ['Par date de facture', 'Par montant décroissant'] },
})

describe('Panneau rapide — file de travaux depuis toute l\'app', () => {
  let browser, ctx, page
  let prompts = []
  let createBody = null
  let replyBody = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })

    // Création court-circuitée : atteindre le serveur déposerait un vrai prompt
    // dans la file (et l'agent partirait dessus).
    await page.route('**/api/travaux/prompts', async (route) => {
      if (route.request().method() === 'POST') {
        createBody = route.request().postDataJSON()
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(base({ id: 'e2e-quick-created' })) })
      }
      return route.continue()
    })
    // Réponse court-circuitée : elle relancerait une vraie exécution.
    await page.route('**/api/travaux/prompts/*/reply', async (route) => {
      replyBody = route.request().postDataJSON()
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    // Liste simulée (le panneau demande ?active=1) : état déterministe.
    await page.route('**/api/travaux/prompts?*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          prompts, agent_enabled: true, runner_busy: true, queue_paused: false,
          queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
  })

  after(async () => { await browser?.close() })

  test('le raccourci clavier ouvre le panneau depuis une page quelconque', async () => {
    prompts = [RUNNING, QUEUED_1, QUEUED_2]
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-quick-button"]', { timeout: 20000 })
    assert.equal(await page.locator('[data-testid="travaux-quick-panel"]').count(), 0, 'panneau fermé au départ')

    await page.keyboard.press('Control+/')
    await page.waitForSelector('[data-testid="travaux-quick-panel"]', { timeout: 5000 })
    // On n'a pas quitté la page.
    assert.ok(page.url().includes('/orders'), 'le panneau ne navigue pas')

    // Échap referme.
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="travaux-quick-panel"]', { state: 'detached', timeout: 5000 })
  })

  test('la file est affichée : ce qui tourne, puis les rangs numérotés', async () => {
    prompts = [RUNNING, QUEUED_1, QUEUED_2]
    await page.click('[data-testid="travaux-quick-button"]')
    const panel = page.locator('[data-testid="travaux-quick-panel"]')
    await panel.waitFor({ timeout: 5000 })

    await panel.locator('[data-testid="travaux-quick-running"]').waitFor({ timeout: 5000 })
    await assert.doesNotReject(panel.locator('text=E2E — tâche en cours').first().waitFor({ timeout: 5000 }))

    const lines = panel.locator('[data-testid="travaux-quick-queue-item"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="travaux-quick-queue-item"]').length === 2, null, { timeout: 5000 })
    assert.equal(await lines.nth(0).getAttribute('data-prompt-id'), 'e2e-quick-q1')
    assert.match(await lines.nth(0).innerText(), /^1\b/, 'le premier de la file porte le rang 1')
    assert.equal(await lines.nth(1).getAttribute('data-prompt-id'), 'e2e-quick-q2')
    assert.match(await lines.nth(1).innerText(), /^2\b/, 'le second porte le rang 2')
  })

  test('le panneau se met à jour en temps réel (événement du canal WS)', async () => {
    const QUEUED_3 = base({ id: 'e2e-quick-q3', title: 'E2E — arrivé en direct', position: 4, wait_rank: 3 })
    prompts = [RUNNING, QUEUED_1, QUEUED_2, QUEUED_3]
    // Exactement l'événement que lib/realtime.js diffuse à la réception du message
    // WebSocket `travaux:prompts:updated`.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('travaux:prompts:updated')))
    await page.waitForSelector('[data-prompt-id="e2e-quick-q3"]', { timeout: 5000 })
  })

  test('ajouter un prompt joint la route ET la fiche affichée', async () => {
    // Fiche détail réelle, en LECTURE seule : on ne fait que l'afficher.
    const ticket = await page.evaluate(async () => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/tickets?limit=1', { headers: { Authorization: `Bearer ${t}` } })
      const j = await r.json()
      return j.data?.[0] || null
    })
    assert.ok(ticket, 'un billet est nécessaire pour tester le contexte « fiche affichée »')

    await page.goto(`${URL}/tickets/${ticket.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`h1:has-text("${ticket.title}")`, { timeout: 20000 })

    await page.click('[data-testid="travaux-quick-button"]')
    const panel = page.locator('[data-testid="travaux-quick-panel"]')
    await panel.waitFor({ timeout: 5000 })

    const contextText = await panel.locator('[data-testid="travaux-quick-context"]').innerText()
    assert.ok(contextText.includes(`/tickets/${ticket.id}`), `la route doit être jointe (vu : ${contextText})`)
    assert.ok(contextText.includes(ticket.title), `la fiche affichée doit être jointe (vu : ${contextText})`)

    createBody = null
    await panel.locator('[data-testid="travaux-quick-input"]').fill('E2E — vérifier le contexte joint')
    await panel.locator('[data-testid="travaux-quick-submit"]').click()
    await page.waitForFunction(() => true)
    await page.waitForTimeout(1000)

    assert.ok(createBody, 'la création doit partir')
    assert.equal(createBody.space, 'finance')
    assert.ok(createBody.prompt.includes('E2E — vérifier le contexte joint'), 'le texte saisi est envoyé')
    assert.ok(createBody.prompt.includes(`Contexte (ERP) : /tickets/${ticket.id}`), `le contexte de page est pré-rempli (vu : ${createBody.prompt})`)
    assert.ok(createBody.prompt.includes(`fiche affichée : « ${ticket.title} »`), `la fiche affichée est jointe (vu : ${createBody.prompt})`)
    // Toujours sur la fiche : le panneau ne fait pas quitter la page.
    assert.ok(page.url().includes(`/tickets/${ticket.id}`))
  })

  test('répondre à une question de Claude sans quitter la page', async () => {
    prompts = [ASKING, RUNNING, QUEUED_1]
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('travaux:prompts:updated')))

    const card = page.locator('[data-testid="travaux-quick-asking"]')
    await card.waitFor({ timeout: 5000 })
    await assert.doesNotReject(card.locator('text=Trier par date ou par montant').first().waitFor({ timeout: 5000 }))

    replyBody = null
    const options = card.locator('[data-testid="travaux-question-option"]')
    assert.equal(await options.count(), 2, 'les deux choix doivent être proposés')
    await options.nth(1).click()
    await page.waitForTimeout(1000)

    assert.ok(replyBody, 'la réponse doit partir')
    assert.equal(replyBody.text, 'Par montant décroissant')
    assert.ok(page.url().includes('/tickets/'), 'on répond sans quitter la page')
  })
})
