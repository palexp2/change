// Travaux → « Conversations » : un travail TERMINÉ doit y être retrouvable même
// s'il a été lancé depuis l'autre section. Cas réel du 9 août 2026 : une suggestion
// de Claude acceptée depuis la section Agent (file `agent`) finissait invisible pour
// qui la cherchait dans /travaux (file `finance`) — la page ne chargeait que sa
// propre file. La vue « File » reste, elle, propre à la section (son ordre lui est
// propre) ; seule l'historique est réunie, avec un repère de provenance.
//
// Sécurité : un seul item réel, créé « de côté » (status paused → jamais ramassé par
// l'ordonnanceur, aucune exécution), passé en `cancelled` pour entrer dans
// l'historique sans qu'aucun agent ne tourne, puis supprimé dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — les conversations réunissent les deux files', () => {
  let browser, ctx, page
  let promptId = null
  const title = `E2E cross-space ${Date.now()}`

  const api = (fn, arg) => page.evaluate(fn, arg)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Item dans la file « agent », terminé (cancelled) : exactement la situation
    // d'une suggestion acceptée depuis /agent et déjà traitée.
    promptId = await api(async (title) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const created = await (await fetch('/erp/api/travaux/prompts', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          title,                                        // titre figé : pas d'appel modèle
          prompt: 'Ne rien faire — item de test E2E.',
          mode: 'question',
          status: 'paused',                             // jamais démarré
          space: 'agent',
        }),
      })).json()
      await fetch(`/erp/api/travaux/prompts/${created.id}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ status: 'cancelled' }),
      })
      return created.id
    }, title)
    assert.ok(promptId, 'création de l\'item jetable')
  })

  after(async () => {
    if (page && promptId) {
      await api(async (id) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/travaux/prompts/${id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      }, promptId)
    }
    await browser?.close()
  })

  test('une conversation de la file Agent apparaît dans /travaux, marquée « Agent »', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="travaux-view-conversations"]').waitFor({ timeout: 15000 })

    // Vue « File » de l'Espace finance : l'item de la file Agent n'y est PAS.
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-prompt-id="${id}"]`),
      promptId, { timeout: 10000 })

    // Vue « Conversations » : il y est, avec son repère de provenance.
    await page.locator('[data-testid="travaux-view-conversations"]').click()
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 10000 })
    const badge = card.locator('[data-testid="travaux-space-badge"]')
    assert.equal(await badge.count(), 1, 'un repère de section est attendu sur une conversation venue de l\'autre file')
    assert.equal(await badge.getAttribute('data-space'), 'agent')
    assert.match((await badge.textContent()).trim(), /Agent/)
  })

  // L'item jetable vient d'être « terminé » (cancelled à l'instant) : c'est donc lui
  // qui doit ouvrir la liste. Avant correctif, l'ordre venait du serveur (position
  // dans la file, puis date de création) et une tâche qui venait de finir pouvait se
  // retrouver hors des 15 premières — donc invisible.
  test('les conversations sont classées de la plus récemment terminée à la plus ancienne', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="travaux-view-conversations"]').click()
    await page.locator(`[data-prompt-id="${promptId}"]`).waitFor({ timeout: 10000 })

    const ids = await page.$$eval('[data-prompt-id]', els => els.map(e => e.dataset.promptId))
    assert.equal(ids[0], promptId, 'la conversation la plus récemment terminée doit ouvrir la liste')

    // Et l'ordre complet doit être décroissant sur la date de fin.
    const dates = await api(async (ids) => {
      const token = localStorage.getItem('erp_token')
      const { prompts } = await (await fetch('/erp/api/travaux/prompts', {
        headers: { Authorization: `Bearer ${token}` },
      })).json()
      const byId = new Map(prompts.map(p => [p.id, p]))
      return ids.map(id => byId.get(id)?.completed_at || null)
    }, ids)
    for (let i = 1; i < dates.length; i++) {
      if (!dates[i] || !dates[i - 1]) continue
      assert.ok(dates[i - 1] >= dates[i], `ordre décroissant attendu : ${dates[i - 1]} avant ${dates[i]}`)
    }
  })

  // L'exécuteur est partagé : ce qui tourne dans la file Agent bloque aussi l'Espace
  // finance. La vue « File » doit donc le montrer — sinon la file paraît en panne sans
  // qu'on voie ce qui l'occupe. Liste interceptée : aucun agent ne tourne pour de vrai.
  test('la vue File montre l\'item actif de l\'autre file, badgé et non réordonnable', async () => {
    const RUNNING_OTHER = {
      id: 'e2e-other-running', space: 'agent', title: 'E2E en cours dans la file Agent',
      prompt: 'Rien.', status: 'running', run_state: 'executing', mode: 'implement',
      preset: 'deep', same_context: 0, title_auto: 0, stop_after: 0, position: 0,
      pending_question: null, user_summary: null, agent_status: 'in_progress', lane: 'exec',
      created_at: '2026-08-09T00:00:00.000Z', started_at: '2026-08-09T00:00:00.000Z',
      completed_at: null, wait_rank: null, messages: [],
    }
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [RUNNING_OTHER], agent_enabled: true, runner_busy: true,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
    try {
      await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
      const card = page.locator('[data-prompt-id="e2e-other-running"]')
      await card.waitFor({ timeout: 10000 })
      assert.equal(await card.locator('[data-testid="travaux-space-badge"]').getAttribute('data-space'), 'agent')
      // Pas de poignée de glissement : on ne réordonne pas la file d'à côté d'ici.
      assert.equal(await card.locator('[draggable="true"]').count(), 0,
        'un item de l\'autre file ne doit pas être déplaçable ici')
    } finally {
      await page.unroute('**/api/travaux/prompts*')
    }
  })

  test('dans sa propre section, la conversation ne porte pas de repère', async () => {
    await page.goto(URL + '/agent/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="travaux-view-conversations"]').waitFor({ timeout: 15000 })
    await page.locator('[data-testid="travaux-view-conversations"]').click()

    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 10000 })
    assert.equal(await card.locator('[data-testid="travaux-space-badge"]').count(), 0,
      'pas de repère quand la conversation est dans sa propre section')
  })
})
