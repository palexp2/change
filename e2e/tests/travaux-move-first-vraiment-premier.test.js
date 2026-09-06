// Travaux → « Passer en premier » : l'item promu part VRAIMENT en premier.
//
// Deux comportements couverts :
//   1. La pastille d'un item remis à l'ordonnanceur mais pas démarré affiche
//      « En file · rang » — plus de libellé « En attente » redondant.
//   2. « Passer en premier » place l'item DEVANT les tâches déjà remises à
//      l'ordonnanceur (elles lui sont reprises), pas seulement devant celles
//      encore en file — c'était le bug : l'item promu partait après elles.
//
// Sécurité (la DB de prod est aussi celle des tests) :
//   - la file est mise en PAUSE pendant tout le test (état capturé puis restauré) :
//     aucune exécution réelle ne démarre — ni les items du test, ni les vrais.
//   - les items du test sont en mode « question » : la promotion ne reprend que la
//     voie questions, les chantiers réels en attente ne sont jamais touchés.
//   - after() : suppression des items du test, suppression de la tâche agent
//     annulée créée par la relance de W, puis restauration de l'état de pause.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — « Passer en premier » passe avant les tâches remises à l\'agent', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const ids = {}            // W (remis à l'ordonnanceur) / C (promu) → id
  let taskIdW = null        // tâche agent créée par la relance de W, à purger
  let pausedByTest = false  // on ne restaure la reprise que si NOUS avons posé la pause

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
    return { W: byId[ids.W], C: byId[ids.C], order: (body?.prompts || []).map(p => p.id) }
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

    // Pause de la file AVANT toute création : rien ne doit démarrer pour vrai.
    const pause = await req('GET', '/travaux/queue/pause')
    if (!pause.body?.paused) {
      const set = await req('POST', '/travaux/queue/pause', { paused: true, reason: 'E2E passer en premier' })
      assert.equal(set.status, 200, 'pose de la pause')
      pausedByTest = true
    }

    // W puis C, en file (queued). Titres explicites (pas de titre auto → pas
    // d'appel modèle), préréglage concret (pas de classification modèle).
    for (const k of ['W', 'C']) {
      const created = await req('POST', '/travaux/prompts', {
        title: `E2E premier ${k} ${stamp}`,
        prompt: 'Ne rien faire — item de test E2E.',
        mode: 'question',
        preset: 'fast',
      })
      assert.equal(created.status, 201, `création de l'item ${k}`)
      ids[k] = created.body.id
    }

    // W est remis à l'ordonnanceur via une relance « tout de suite » : il devient
    // l'ex-« En attente » (running côté DB, jamais démarré grâce à la pause).
    const reply = await req('POST', `/travaux/prompts/${ids.W}/reply`, { text: 'Vas-y.', placement: 'front' })
    assert.equal(reply.status, 201, 'relance de W')
    assert.equal(reply.body.run_state, 'waiting', 'W doit être remis à l\'ordonnanceur sans démarrer')
    taskIdW = reply.body.agent_task_id
  })

  after(async () => {
    if (page) {
      // Suppression des items du test, purge de la tâche agent annulée de W,
      // puis restauration de l'état de pause — dans cet ordre : rien du test ne
      // doit rester quand la file redémarre.
      for (const id of Object.values(ids)) {
        await req('DELETE', `/travaux/prompts/${id}`).catch(() => {})
      }
      if (taskIdW) await req('DELETE', `/agent/tasks/${taskIdW}`).catch(() => {})
      if (pausedByTest) await req('POST', '/travaux/queue/pause', { paused: false }).catch(() => {})
    }
    await browser?.close()
  })

  test('un item remis à l\'agent affiche « En file · rang », plus « En attente »', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const cardW = page.locator(`[data-prompt-id="${ids.W}"]`)
    await cardW.waitFor({ timeout: 15000 })

    await cardW.locator('text=En file ·').first().waitFor({ timeout: 5000 })
    assert.equal(await cardW.locator('text=En attente').count(), 0,
      'le libellé « En attente » ne doit plus apparaître')

    // Précondition du bug : W est bien devant C (remis à l'ordonnanceur d'abord).
    const { W, C } = await myPrompts()
    assert.equal(W.run_state, 'waiting')
    assert.ok(W.wait_rank < C.wait_rank, `W (${W.wait_rank}) devrait précéder C (${C.wait_rank})`)
  })

  test('« Passer en premier » reprend les tâches remises à l\'agent et passe devant', async () => {
    await page.locator(`[data-prompt-id="${ids.C}"]`).getByTestId('travaux-move-first').click()

    // Côté serveur : W est repris (redevenu « en file ») et C le précède.
    let state = null
    for (let i = 0; i < 30; i++) {
      state = await myPrompts()
      if (state.W?.status === 'queued' && state.C && state.C.wait_rank < state.W.wait_rank) break
      await new Promise(r => setTimeout(r, 300))
    }
    assert.equal(state.W?.status, 'queued', 'W doit être repris à l\'ordonnanceur (statut en file)')
    assert.equal(state.C?.status, 'queued', 'file en pause : C ne doit pas démarrer')
    assert.ok(state.C.position < state.W.position,
      `C (${state.C.position}) doit précéder W (${state.W.position}) en position`)
    assert.ok(state.C.wait_rank < state.W.wait_rank,
      `C (rang ${state.C.wait_rank}) doit partir avant W (rang ${state.W.wait_rank})`)
    assert.ok(state.order.indexOf(ids.C) < state.order.indexOf(ids.W), 'ordre de liste serveur')

    // Et à l'écran : la carte C remonte au-dessus de W, pastille « En file ».
    await page.waitForFunction(({ c, w }) => {
      const shown = [...document.querySelectorAll('[data-prompt-id]')].map(el => el.getAttribute('data-prompt-id'))
      return shown.indexOf(c) !== -1 && shown.indexOf(c) < shown.indexOf(w)
    }, { c: ids.C, w: ids.W }, { timeout: 10000 })
    await page.locator(`[data-prompt-id="${ids.C}"]`).locator('text=En file ·').first().waitFor({ timeout: 5000 })
  })
})
