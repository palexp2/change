// Travaux → « Passer en premier » : la carte remonte AU CLIC, pas après
// l'aller-retour serveur.
//
// Le bouton était perçu comme lent : il attendait la réponse du serveur PUIS le
// rechargement de la file complète (une centaine de Ko, tout l'historique et ses
// fils) avant que quoi que ce soit ne bouge à l'écran. Le mouvement est désormais
// joué localement au clic (comme la corbeille et le glisser-déposer).
//
// Preuve, plutôt qu'un seuil de chronomètre fragile : le réseau est délibérément
// ralenti de 2 s sur /travaux/prompts (liste ET promotion) ; si la carte remonte
// quand même en moins d'une seconde, c'est qu'elle ne dépend plus du serveur.
//
// Sécurité (la DB de prod est aussi celle des tests) :
//   - file mise en PAUSE pendant le test (état capturé puis restauré) : aucune
//     exécution réelle ne démarre ;
//   - items en mode « question » : la promotion ne reprend que la voie questions,
//     les chantiers réels en attente ne sont jamais touchés ;
//   - after() : suppression des items du test, puis restauration de la pause.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SLOW_MS = 2000        // ralentissement imposé au réseau
const BUDGET_MS = 1000      // au-delà, la carte attendait encore le serveur

describe('Travaux — « Passer en premier » remonte la carte immédiatement', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const ids = {}              // A (devant) / B (derrière, celui qu'on promeut)
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
      const set = await req('POST', '/travaux/queue/pause', { paused: true, reason: 'E2E premier instantané' })
      assert.equal(set.status, 200, 'pose de la pause')
      pausedByTest = true
    }

    // Titres explicites (pas de titre auto → pas d'appel modèle), préréglage
    // concret (pas de classification modèle).
    for (const k of ['A', 'B']) {
      const created = await req('POST', '/travaux/prompts', {
        title: `E2E premier instantané ${k} ${stamp}`,
        prompt: 'Ne rien faire — item de test E2E.',
        mode: 'question',
        preset: 'fast',
      })
      assert.equal(created.status, 201, `création de l'item ${k}`)
      ids[k] = created.body.id
    }
  })

  after(async () => {
    if (page) {
      await page.unroute('**/api/travaux/prompts**').catch(() => {})
      for (const id of Object.values(ids)) {
        await req('DELETE', `/travaux/prompts/${id}`).catch(() => {})
      }
      if (pausedByTest) await req('POST', '/travaux/queue/pause', { paused: false }).catch(() => {})
    }
    await browser?.close()
  })

  test('la carte passe en tête sans attendre le serveur', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const cardA = page.locator(`[data-prompt-id="${ids.A}"]`)
    const cardB = page.locator(`[data-prompt-id="${ids.B}"]`)
    await cardA.waitFor({ timeout: 15000 })
    await cardB.waitFor({ timeout: 15000 })

    const orderOf = () => page.evaluate(({ a, b }) => {
      const shown = [...document.querySelectorAll('[data-prompt-id]')].map(el => el.getAttribute('data-prompt-id'))
      return { a: shown.indexOf(a), b: shown.indexOf(b) }
    }, { a: ids.A, b: ids.B })

    const before = await orderOf()
    assert.ok(before.a < before.b, `précondition : A (${before.a}) doit précéder B (${before.b})`)

    // Réseau volontairement lent sur la file : liste ET promotion.
    await page.route('**/api/travaux/prompts**', async route => {
      await new Promise(r => setTimeout(r, SLOW_MS))
      await route.continue()
    })

    const t0 = Date.now()
    await cardB.getByTestId('travaux-move-first').click()
    await page.waitForFunction(({ a, b }) => {
      const shown = [...document.querySelectorAll('[data-prompt-id]')].map(el => el.getAttribute('data-prompt-id'))
      return shown.indexOf(b) !== -1 && shown.indexOf(b) < shown.indexOf(a)
    }, { a: ids.A, b: ids.B }, { timeout: 15000 })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < BUDGET_MS,
      `la carte doit remonter tout de suite (${elapsed} ms, réseau ralenti de ${SLOW_MS} ms)`)

    // Et la promotion est bien allée jusqu'au serveur (une fois le réseau rendu).
    await page.unroute('**/api/travaux/prompts**')
    let state = null
    for (let i = 0; i < 30; i++) {
      state = await myPrompts()
      if (state.B && state.A && state.B.position < state.A.position) break
      await new Promise(r => setTimeout(r, 300))
    }
    assert.ok(state.B.position < state.A.position,
      `B (${state.B?.position}) doit précéder A (${state.A?.position}) côté serveur`)
    assert.equal(state.B.status, 'queued', 'file en pause : B ne doit pas démarrer')

    // Le mouvement local ne « colle » pas : après confirmation, l'écran suit
    // toujours le serveur.
    const after = await orderOf()
    assert.ok(after.b < after.a, `B (${after.b}) reste devant A (${after.a}) après confirmation`)
  })
})
