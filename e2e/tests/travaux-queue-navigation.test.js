// Travaux → « Ma file de prompts » : la navigation compacte (File /
// Conversations), les cartes repliées, l'édition du prompt sans perte de frappe,
// et le fait qu'un item « en attente » reste modifiable et déplaçable.
//
// Sécurité : le seul item réel est créé « de côté » (status paused) — l'ordonnanceur
// ne le ramasse JAMAIS, donc aucune exécution réelle de l'agent — puis supprimé dans
// le hook after(). Les cas « en attente » / « terminé » passent par une INTERCEPTION
// de la liste : rien n'est écrit en base, et les PATCH de ces cartes factices sont
// court-circuités avant d'atteindre le serveur.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const base = {
  // La page ne montre dans sa vue « File » que les items de SA file (les
  // conversations, elles, réunissent les deux) : le faux item doit donc porter la
  // file de la page testée, comme le fait le serveur.
  space: 'finance',
  mode: 'implement', preset: 'deep', same_context: 0, title_auto: 0, stop_after: 0,
  pending_question: null, user_summary: null, agent_status: null, lane: 'exec',
  created_at: '2026-08-04T00:00:00.000Z', completed_at: null,
}
// Deux items « en attente » : remis à l'ordonnanceur, aucun démarré. Il en faut
// deux pour que la poignée de priorité ait un sens (on ne réordonne pas un
// groupe d'un seul item).
const WAITING = [1, 2].map(n => ({
  ...base,
  id: `e2e-waiting-${n}`,
  title: `E2E en attente ${n}`,
  prompt: `Prompt en attente ${n}.`,
  status: 'running',
  run_state: 'waiting',
  position: n,
  started_at: '2026-08-04T00:00:00.000Z',
  wait_rank: n,
  messages: [],
}))
const DONE = {
  ...base,
  id: 'e2e-done-thread',
  title: 'E2E conversation terminée',
  prompt: 'Range les factures.',
  status: 'done',
  run_state: null,
  position: 9,
  started_at: '2026-08-04T00:00:00.000Z',
  completed_at: '2026-08-04T00:30:00.000Z',
  wait_rank: null,
  messages: Array.from({ length: 6 }, (_, i) => ({
    id: `e2e-msg-${i}`,
    prompt_id: 'e2e-done-thread',
    role: i % 2 ? 'user' : 'agent',
    text: `Message numéro ${i + 1} du fil.`,
    created_at: `2026-08-04T00:0${i}:00.000Z`,
  })),
}

describe('Travaux — navigation compacte de la file', () => {
  let browser, ctx, page
  let promptId = null
  const title = `E2E navigation ${Date.now()}`

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

    const created = await api(async (title) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/prompts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,                                   // titre figé : pas de titre auto,
          prompt: 'Ne rien faire — item de test E2E.',  // donc pas d'appel modèle
          mode: 'question',
          status: 'paused',                        // jamais ramassé par l'ordonnanceur
        }),
      })
      return r.json()
    }, title)
    promptId = created.id
    assert.ok(promptId, 'création du prompt jetable')
  })

  after(async () => {
    if (page) {
      await api(async (id) => {
        const token = localStorage.getItem('erp_token')
        if (id) {
          await fetch(`/erp/api/travaux/prompts/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {})
        }
      }, promptId)
    }
    await browser?.close()
  })

  test('la file se lit en deux vues : « File » et « Conversations »', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-prompt-id="${promptId}"]`, { timeout: 15000 })

    await page.locator('[data-testid="travaux-view-file"]').waitFor({ timeout: 5000 })
    await page.locator('[data-testid="travaux-view-conversations"]').waitFor({ timeout: 5000 })

    // La vue « Conversations » ne contient QUE des tâches terminées : l'item de
    // côté du test doit en disparaître (c'est tout l'intérêt de la séparation).
    await page.locator('[data-testid="travaux-view-conversations"]').click()
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-prompt-id="${id}"]`),
      promptId, { timeout: 10000 })

    await page.locator('[data-testid="travaux-view-file"]').click()
    await page.waitForSelector(`[data-prompt-id="${promptId}"]`, { timeout: 10000 })
  })

  test('une carte de la file est repliée : ni fil ni prompt tant qu\'on ne l\'ouvre pas', async () => {
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    assert.equal(await card.getAttribute('data-prompt-open'), '0', 'la carte doit être repliée au départ')
    assert.equal(await card.locator('[data-testid="travaux-prompt-input"]').count(), 0,
      'le prompt ne doit pas être rendu tant que la carte est repliée')
    // Le titre, lui, reste éditable en place sur la ligne repliée.
    assert.equal(await card.locator(`input[value="${title}"]`).count(), 1, 'titre éditable attendu sur la ligne')

    await card.locator('[data-testid="travaux-toggle"]').click()
    await card.locator('[data-testid="travaux-prompt-input"]').waitFor({ timeout: 5000 })
    assert.equal(await card.getAttribute('data-prompt-open'), '1')

    await card.locator('[data-testid="travaux-toggle"]').click()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptOpen === '0',
      promptId, { timeout: 5000 })
  })

  test('modifier le prompt d\'un item en file : aucun caractère perdu pendant la frappe', async () => {
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    // Plus de crayon : ouvrir la carte suffit pour accéder au prompt.
    assert.equal(await card.locator('[data-testid="travaux-edit-prompt"]').count(), 0,
      'le bouton crayon a été retiré')
    await card.locator('[data-testid="travaux-toggle"]').click()
    const box = card.locator('[data-testid="travaux-prompt-input"]')
    await box.waitFor({ timeout: 5000 })

    const typed = 'Ne rien faire — frappe continue E2E 0123456789 abcdefghijklmnop.'
    await box.fill('')
    // Frappe lente (≈ 4 s) : elle traverse plusieurs fenêtres d'autosave, donc
    // plusieurs sauvegardes ET plusieurs rechargements de la liste tombent AU
    // MILIEU de la saisie. C'est exactement le cas qui faisait disparaître des
    // caractères et sauter le curseur.
    await box.type(typed, { delay: 60 })

    assert.equal(await box.inputValue(), typed, 'des caractères ont été perdus pendant la frappe')

    // Puis la valeur doit vraiment être arrivée au serveur (autosave, pas de bouton).
    await box.blur()
    const saved = await api(async ({ id, typed }) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 25; i++) {
        const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
        const { prompts } = await r.json()
        const p = prompts.find(x => x.id === id)
        if (p?.prompt === typed) return true
        await new Promise(res => setTimeout(res, 400))
      }
      return false
    }, { id: promptId, typed })
    assert.equal(saved, true, 'le prompt modifié n\'a pas été enregistré')

    // Le champ ne doit pas non plus avoir été réécrit par le rechargement d'après.
    await page.waitForTimeout(1500)
    assert.equal(await box.inputValue(), typed, 'le rechargement a écrasé le champ')
  })

  test('un item « en attente » reste modifiable et déplaçable', async () => {
    // Liste interceptée : deux items « en attente » + une conversation terminée.
    // Rien n'est écrit en base, et les PATCH sont court-circuités.
    const patched = []
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [...WAITING, DONE], agent_enabled: true, runner_busy: false,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
    await page.route('**/api/travaux/prompts/e2e-*', async (route) => {
      const req = route.request()
      if (req.method() === 'PATCH') patched.push(req.postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WAITING[0]) })
    })

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const card = page.locator('[data-prompt-id="e2e-waiting-1"]')
    await card.waitFor({ timeout: 15000 })

    // Pastille : un item remis à l'agent mais pas démarré s'affiche « En file »
    // avec son rang — plus de libellé « En attente » redondant.
    await card.locator('text=En file · 1er').first().waitFor({ timeout: 5000 })

    // Les affordances qui manquaient : réordonner, passer en premier, éditer
    // (l'édition passe par l'ouverture de la carte — le crayon a été retiré).
    assert.equal(await card.locator('[data-testid="travaux-drag-handle"]').count(), 1,
      'un item en attente doit pouvoir être glissé')
    assert.equal(await card.getByTestId('travaux-move-down').count(), 1, 'flèche de priorité attendue')
    assert.equal(await card.getByTestId('travaux-move-first').count(), 1, '« passer en premier » attendu')
    assert.equal(await card.getByTestId('travaux-edit-prompt').count(), 0, 'le bouton crayon a été retiré')

    await card.getByTestId('travaux-toggle').click()
    const box = card.locator('[data-testid="travaux-prompt-input"]')
    await box.waitFor({ timeout: 5000 })
    await box.fill('Prompt réécrit avant démarrage.')
    await box.blur()

    await page.waitForFunction(() => true, null, { timeout: 500 }).catch(() => {})
    for (let i = 0; i < 25 && !patched.some(p => p.prompt); i++) await new Promise(r => setTimeout(r, 200))
    assert.ok(patched.some(p => p.prompt === 'Prompt réécrit avant démarrage.'),
      'la modification d\'un item en attente doit être envoyée au serveur')
  })

  test('une conversation terminée est repliée et son fil se déroule à la demande', async () => {
    await page.locator('[data-testid="travaux-view-conversations"]').click()
    const card = page.locator('[data-prompt-id="e2e-done-thread"]')
    await card.waitFor({ timeout: 10000 })

    assert.equal(await card.getAttribute('data-prompt-open'), '0', 'une conversation terminée s\'affiche repliée')
    assert.equal(await card.locator('text=Message numéro 1 du fil.').count(), 0,
      'le fil ne doit pas être déroulé sur une carte repliée')

    // Le bouton « répondre » ouvre la carte et amène droit à la zone de réponse.
    await card.getByTestId('travaux-reply').click()
    await card.locator('textarea[placeholder^="Répondre à Claude"]').waitFor({ timeout: 5000 })

    // Fil long : seuls les derniers messages sont rendus, les précédents à la demande.
    assert.equal(await card.locator('text=Message numéro 6 du fil.').count(), 1, 'le dernier message doit être visible')
    assert.equal(await card.locator('text=Message numéro 1 du fil.').count(), 0,
      'les vieux messages doivent rester repliés')
    await card.getByTestId('travaux-show-thread').click()
    await card.locator('text=Message numéro 1 du fil.').waitFor({ timeout: 5000 })

    await page.unroute('**/api/travaux/prompts*')
    await page.unroute('**/api/travaux/prompts/e2e-*')
  })
})
