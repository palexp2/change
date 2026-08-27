// Travaux — répondre à une tâche terminée : choix « début » ou « fin de file ».
//
// Jusqu'ici, répondre à un item terminé le relançait TOUT DE SUITE (devant le
// reste de la file). La zone de réponse offre désormais deux boutons : « Relancer
// au début de la file » (comportement historique) et « À la fin de la file » (la
// réponse est enregistrée, la tâche retourne derrière les items en attente et
// repartira quand son tour reviendra, avec le fil complet en contexte).
//
// Sécurité : aucune exécution réelle de l'agent.
//   - tests UI : liste et POST de réponse INTERCEPTÉS (le POST n'atteint jamais le
//     serveur — sinon il relancerait une vraie exécution de Claude).
//   - test API : item jetable créé « de côté », passé à « annulé » (jamais ramassé
//     par l'ordonnanceur), puis réponse `placement:'back'` → il retourne en file
//     SANS démarrer parce que le poste d'exécution est occupé (ce test tourne
//     pendant une implémentation réelle). Garde-fou : si le poste est libre, cette
//     partie est sautée plutôt que de risquer un vrai départ. Nettoyage immédiat.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FAKE = {
  id: 'e2e-reply-placement',
  title: 'E2E réponse début/fin de file',
  prompt: 'Trie les achats.',
  status: 'done',
  position: 1,
  mode: 'implement',
  preset: 'deep',
  same_context: 0,
  title_auto: 0,
  space: 'finance',
  created_at: '2026-08-06T00:00:00.000Z',
  started_at: '2026-08-06T00:00:00.000Z',
  completed_at: '2026-08-06T00:05:00.000Z',
  user_summary: null,
  agent_status: 'done',
  run_state: null,
  lane: 'exec',
  wait_rank: null,
  pending_question: null,
  messages: [{
    id: 'e2e-msg-1',
    prompt_id: 'e2e-reply-placement',
    role: 'agent',
    text: 'C\'est fait — le tri est en place.',
    created_at: '2026-08-06T00:05:00.000Z',
  }],
}

describe('Travaux — réponse : relancer au début ou à la fin de la file', () => {
  let browser, ctx, page
  let token = null
  const stamp = Date.now()
  const created = []          // ids réels à supprimer en fin de test
  const replies = []          // payloads de réponse capturés (jamais transmis)

  // Appels API réels depuis le process de test (hors page → hors interception).
  const call = async (method, path, body) => {
    const r = await fetch(`${URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await r.json() } catch { /* réponse vide */ }
    return { status: r.status, body: json }
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // La liste rendue à la page = uniquement l'item factice terminé.
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            prompts: [FAKE], agent_enabled: true, runner_busy: false,
            running_questions: 0, max_parallel_questions: 2,
            queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          }),
        })
      }
      return route.continue()
    })
    // Réponse capturée puis court-circuitée : atteindre le serveur relancerait une
    // vraie exécution de l'agent.
    await page.route('**/api/travaux/prompts/*/reply', async (route) => {
      replies.push(route.request().postDataJSON())
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ ...FAKE, status: 'queued' }),
      })
    })
  })

  after(async () => {
    for (const id of created) {
      await call('DELETE', `/travaux/prompts/${id}`).catch(() => {})
    }
    await browser?.close()
  })

  test('un item terminé offre les deux départs : début et fin de file', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    // Un item terminé (sans question en attente) vit dans la vue « Conversations ».
    await page.click('[data-testid="travaux-view-conversations"]')
    const card = page.locator('[data-prompt-id="e2e-reply-placement"]')
    await card.waitFor({ timeout: 20000 })

    // Ouvrir la conversation (item terminé → zone de réponse).
    await card.locator('[data-testid="travaux-reply"]').click()
    const front = card.locator('[data-testid="travaux-reply-front"]')
    const back = card.locator('[data-testid="travaux-reply-back"]')
    await front.waitFor({ timeout: 10000 })
    await back.waitFor({ timeout: 10000 })
    assert.match(await front.innerText(), /début de la file/i)
    assert.match(await back.innerText(), /fin de la file/i)
    // Rien à envoyer → les deux boutons attendent un texte.
    assert.equal(await front.isDisabled(), true)
    assert.equal(await back.isDisabled(), true)
  })

  test('« À la fin de la file » envoie placement:back ; « au début » envoie placement:front', async () => {
    const card = page.locator('[data-prompt-id="e2e-reply-placement"]')
    const textarea = card.locator('textarea[placeholder^="Répondre à Claude"]')

    await textarea.fill('Réponse E2E — fin de file.')
    await card.locator('[data-testid="travaux-reply-back"]').click()
    for (let i = 0; i < 25 && replies.length < 1; i++) await new Promise(r => setTimeout(r, 200))
    assert.equal(replies.length, 1, 'la réponse « fin de file » doit partir en un POST')
    assert.equal(replies[0].text, 'Réponse E2E — fin de file.')
    assert.equal(replies[0].placement, 'back')

    // Le champ se vide après l'envoi, puis on repart par l'autre bouton.
    await page.waitForFunction(
      () => document.querySelector('[data-prompt-id="e2e-reply-placement"] textarea')?.value === '',
      null, { timeout: 5000 },
    )
    await textarea.fill('Réponse E2E — début de file.')
    await card.locator('[data-testid="travaux-reply-front"]').click()
    for (let i = 0; i < 25 && replies.length < 2; i++) await new Promise(r => setTimeout(r, 200))
    assert.equal(replies.length, 2, 'la réponse « début de file » doit partir en un POST')
    assert.equal(replies[1].placement, 'front')
  })

  test('API : une réponse placement:back remet l\'item en FIN de file, sans le démarrer', async (t) => {
    // Garde-fou : cette partie touche le vrai serveur. L'item de test (mode
    // implémentation) ne peut pas démarrer tant que le poste d'exécution est
    // occupé — si rien ne tourne, on saute plutôt que de risquer un vrai départ.
    const snapshot = await call('GET', '/travaux/prompts?space=agent')
    assert.equal(snapshot.status, 200)
    if (!snapshot.body.runner_busy) {
      t.skip('poste d\'exécution libre — aller-retour réel sauté par prudence')
      return
    }

    const createdRes = await call('POST', '/travaux/prompts', {
      title: `E2E placement ${stamp}`,
      prompt: 'Ne rien faire — item de test E2E (réponse fin de file).',
      mode: 'implement', status: 'paused', space: 'agent',
    })
    assert.equal(createdRes.status, 201)
    const id = createdRes.body.id
    created.push(id)

    // « Annulé » : hors de la file, mais avec un statut terminé — répondable.
    const cancelled = await call('PATCH', `/travaux/prompts/${id}`, { status: 'cancelled' })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.status, 'cancelled')

    // Placement invalide refusé.
    const bad = await call('POST', `/travaux/prompts/${id}/reply`, { text: 'x', placement: 'middle' })
    assert.equal(bad.status, 400)

    const reply = await call('POST', `/travaux/prompts/${id}/reply`, {
      text: 'Réponse E2E — remets-la en fin de file.', placement: 'back',
    })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.status, 'queued', 'l\'item doit retourner en file, pas démarrer')
    assert.equal(reply.body.follow_up, 1, 'le prochain départ doit être marqué « suite de conversation »')

    // En FIN de file : derrière tous les autres items de sa file.
    const list = await call('GET', '/travaux/prompts?space=agent')
    const others = list.body.prompts.filter(p => p.id !== id)
    for (const p of others) {
      assert.ok(reply.body.position > p.position,
        `l'item répondu « fin de file » (${reply.body.position}) devrait suivre « ${p.title} » (${p.position})`)
    }
    // Et la réponse est bien au fil.
    const mine = list.body.prompts.find(p => p.id === id)
    assert.ok(mine.messages.some(m => m.role === 'user' && m.text.includes('fin de file')),
      'la réponse doit être versée au fil')

    // Nettoyage immédiat : l'item ne doit pas rester en file réelle.
    const del = await call('DELETE', `/travaux/prompts/${id}`)
    assert.equal(del.status, 200)
  })
})
