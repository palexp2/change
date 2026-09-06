// Travaux → « Passer en premier » sur un item promu depuis une suggestion,
// alors qu'un autre item est déjà « en file · rang » (remis à l'ordonnanceur).
//
// Bug corrigé : frontPosition() calculait MIN(position) parmi les items
// status='queued' seulement. L'item déjà remis à l'ordonnanceur (running côté
// DB, pas encore démarré) était donc ignoré du calcul — quand il redevenait
// « queued » (repris par un reply/patch ultérieur), il retombait exactement à
// la même position que celle attribuée depuis à l'item promu, qui perdait
// alors le départage (par created_at) et semblait ne jamais avancer. C'est ce
// que l'utilisateur observait sur les suggestions intégrées à sa file : plus
// récentes que le reste de la file, elles perdaient systématiquement ce
// départage.
//
// Sécurité (la DB de prod est aussi celle des tests) :
//   - la file est mise en PAUSE pendant tout le test : aucune exécution réelle.
//   - les items du test sont en mode « question » (voie séparée des chantiers).
//   - after() : suppression des items/suggestion créés, purge de la tâche agent
//     annulée, restauration de l'état de pause.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — « Passer en premier » sur une suggestion ne colle plus à l\'item déjà remis à l\'agent', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const ids = {}            // A (remis à l'ordonnanceur) / B (promu depuis une suggestion)
  let suggestionId = null
  let taskIdA = null
  let pausedByTest = false

  const api = (fn, arg) => page.evaluate(fn, arg)

  const req = (method, path, body) => api(async ({ method, path, body }) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { method, path, body })

  const myPrompts = async () => {
    const { body } = await req('GET', '/travaux/prompts')
    const byId = Object.fromEntries((body?.prompts || []).map(p => [p.id, p]))
    return { A: byId[ids.A], B: byId[ids.B] }
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const pause = await req('GET', '/travaux/queue/pause')
    if (!pause.body?.paused) {
      const set = await req('POST', '/travaux/queue/pause', { paused: true, reason: 'E2E passer en premier / suggestion' })
      assert.equal(set.status, 200, 'pose de la pause')
      pausedByTest = true
    }

    // A : item manuel, créé puis passé en tête AVANT de le remettre à
    // l'ordonnanceur. Ce « passer en premier » sur A (pendant qu'il est encore
    // « queued ») le rend strictement plus petit que tout le reste de la file
    // réelle, quel que soit son contenu — ce qui rend la collision testée
    // ci-dessous déterministe (indépendante des données de prod) : une fois A
    // passé « running », le prochain « passer en premier » (sur B) doit encore
    // le considérer, sinon il retombe pile sur l'ancien deuxième-plus-petit,
    // qui vaut alors exactement la position de A.
    // A reste en mode « implement » (défaut) : B (question) ne le reprend donc
    // pas à l'ordonnanceur via son propre « passer en premier » (laneWhere ne
    // touche que la voie question) — exactement le cas d'un vrai chantier en
    // file pendant qu'une suggestion question est promue en tête.
    const createdA = await req('POST', '/travaux/prompts', {
      title: `E2E collide A ${stamp}`,
      prompt: 'Ne rien faire — item de test E2E.',
      preset: 'fast',
    })
    assert.equal(createdA.status, 201, 'création de A')
    ids.A = createdA.body.id
    const frontA = await req('POST', `/travaux/prompts/${ids.A}/first`)
    assert.equal(frontA.status, 200, 'A passé en premier avant sa mise en file d\'attente agent')

    const reply = await req('POST', `/travaux/prompts/${ids.A}/reply`, { text: 'Vas-y.', placement: 'front' })
    assert.equal(reply.status, 201, 'relance de A')
    assert.equal(reply.body.run_state, 'waiting', 'A doit être remis à l\'ordonnanceur sans démarrer')
    taskIdA = reply.body.agent_task_id

    // B : suggestion de Claude, acceptée dans la file — c'est le cas signalé.
    const sugg = await req('POST', '/travaux/suggestions', {
      title: `E2E collide suggestion ${stamp}`,
      prompt: 'Ne rien faire — suggestion de test E2E.',
      kind: 'chantier',
    })
    assert.equal(sugg.status, 201, 'création de la suggestion')
    suggestionId = sugg.body.id
    const accepted = await req('POST', `/travaux/suggestions/${suggestionId}/accept`, { space: 'finance' })
    assert.equal(accepted.status, 200, 'acceptation de la suggestion')
    ids.B = accepted.body.prompt_id
    // B doit être en mode question pour rester sur la voie neutre — forcé ici
    // car acceptSuggestion() ne l'expose pas en paramètre.
    const setMode = await req('PATCH', `/travaux/prompts/${ids.B}`, { mode: 'question', preset: 'fast' })
    assert.equal(setMode.status, 200, 'passage de B en mode question')
  })

  after(async () => {
    if (page) {
      for (const id of Object.values(ids)) {
        await req('DELETE', `/travaux/prompts/${id}`).catch(() => {})
      }
      if (suggestionId) await req('DELETE', `/travaux/suggestions/${suggestionId}`).catch(() => {})
      if (taskIdA) await req('DELETE', `/agent/tasks/${taskIdA}`).catch(() => {})
      if (pausedByTest) await req('POST', '/travaux/queue/pause', { paused: false }).catch(() => {})
    }
    await browser?.close()
  })

  test('« Passer en premier » sur B obtient une position strictement < celle de A, même si A est « en file · rang »', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const cardB = page.locator(`[data-prompt-id="${ids.B}"]`)
    await cardB.waitFor({ timeout: 15000 })

    // Précondition : A est bien remis à l'ordonnanceur (running côté DB).
    let pre = await myPrompts()
    assert.equal(pre.A?.status, 'running', 'A doit être remis à l\'ordonnanceur avant le clic')

    await cardB.getByTestId('travaux-move-first').click()

    let state = null
    for (let i = 0; i < 30; i++) {
      state = await myPrompts()
      if (state.B?.status === 'queued') break
      await new Promise(r => setTimeout(r, 300))
    }
    assert.equal(state.B?.status, 'queued', 'file en pause : B ne doit pas démarrer')
    assert.notEqual(state.B.position, state.A.position,
      `B (${state.B.position}) et A (${state.A.position}) ne doivent JAMAIS partager la même position`)
    assert.ok(state.B.position < state.A.position,
      `B (${state.B.position}) doit précéder A (${state.A.position}) — même si A est encore « en file · rang »`)

    // A est ensuite repris à l'ordonnanceur (comme le ferait une vraie reprise
    // de file) : sa position ne bouge pas, et ne doit toujours pas entrer en
    // collision avec celle de B.
    const reclaim = await req('PATCH', `/travaux/prompts/${ids.A}`, { status: 'queued' })
    assert.equal(reclaim.status, 200)
    const after = await myPrompts()
    assert.equal(after.A?.status, 'queued')
    assert.notEqual(after.B.position, after.A.position, 'toujours pas de collision une fois A repris en file')
    assert.ok(after.B.position < after.A.position, 'B doit rester devant A après reprise')
  })
})
