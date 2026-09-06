// Travaux → « Nouveau prompt » : bouton de placement « Au début / À la fin de la file ».
//
// Jusqu'ici un nouvel item se déposait toujours en fin de file et il fallait
// cliquer « Passer en premier » sur sa carte. Le bouton (une bascule discrète,
// partagée avec le panneau rapide et la bulle « Modifier le système ») le dépose
// directement devant quand on le passe sur « Au début de la file ».
//
// Sécurité : aucune exécution réelle de l'agent.
//   - test UI : la requête de création est interceptée et forcée en `status:paused`
//     + `mode:question` avant d'atteindre le serveur — l'ordonnanceur ne ramasse
//     jamais un item « de côté ». Le vrai chemin serveur est donc bien exercé.
//   - test API : mêmes précautions, items créés directement en pause.
// Les positions des vrais items ne sont jamais renumérotées (aucun appel à
// /reorder) ; le nettoyage se limite à supprimer les items du test.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — placement d\'un nouveau prompt dans la file', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const created = []       // ids à supprimer en fin de test
  let sentBody = null      // payload réellement envoyé par le composeur

  const api = (fn, arg) => page.evaluate(fn, arg)

  const listPrompts = () => api(async () => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
    return (await r.json()).prompts
  })

  const createPrompt = (body) => api(async (body) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }, body)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Garde-fou : toute création partie de cette page est déposée « de côté ».
    await page.route('**/api/travaux/prompts', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      sentBody = JSON.parse(route.request().postData() || '{}')
      await route.continue({
        postData: JSON.stringify({ ...sentBody, status: 'paused', mode: 'question' }),
      })
    })
  })

  after(async () => {
    if (page) {
      await api(async (ids) => {
        const token = localStorage.getItem('erp_token')
        for (const id of ids) {
          await fetch(`/erp/api/travaux/prompts/${id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {})
        }
      }, created)
    }
    await browser?.close()
  })

  test('le composeur offre le bouton de placement, « à la fin » par défaut', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 20000 })
    await page.click('[data-testid="travaux-new-prompt"]')
    const btn = page.locator('[data-testid="travaux-new-priority"]')
    await btn.waitFor({ timeout: 10000 })
    assert.equal(await btn.getAttribute('data-placement'), 'last', 'défaut : fin de file')
    assert.match(await btn.innerText(), /fin de la file/i)
  })

  test('le bouton « Au début » envoie priority et dépose l\'item devant la file', async () => {
    // Le composeur n'a plus de champ « Titre » (déduit du prompt côté serveur) :
    // c'est le prompt, horodaté, qui identifie l'item du test.
    const myPrompt = `Ne rien faire — item de test E2E ${stamp} (priorité).`
    await page.fill('textarea', myPrompt)
    const btn = page.locator('[data-testid="travaux-new-priority"]')
    await btn.click()
    assert.equal(await btn.getAttribute('data-placement'), 'first')
    assert.match(await btn.innerText(), /début de la file/i)

    await page.click('button:has-text("Ajouter à la file")')

    // Le serveur a reçu la demande de priorité…
    await page.waitForFunction(() => !document.querySelector('[data-testid="travaux-new-priority"]'), { timeout: 15000 })
    assert.equal(sentBody?.priority, true, 'priority absent du payload de création')

    // …et l'item existe, en pause (garde-fou), devant les autres items en pause.
    let mine = null
    for (let i = 0; i < 40 && !mine; i++) {
      mine = (await listPrompts()).find(p => p.prompt === myPrompt) || null
      if (!mine) await new Promise(r => setTimeout(r, 300))
    }
    assert.ok(mine, 'item créé introuvable')
    created.push(mine.id)
    assert.equal(mine.status, 'paused', 'garde-fou : l\'item de test doit rester en pause')

    // Position : devant tous les items en file d'attente.
    const queued = (await listPrompts()).filter(p => p.status === 'queued')
    for (const q of queued) {
      assert.ok(mine.position < q.position,
        `l'item prioritaire (${mine.position}) devrait précéder « ${q.title} » (${q.position})`)
    }
  })

  test('sans la case, un nouvel item se dépose en fin de file', async () => {
    const before = await listPrompts()
    const maxPos = Math.max(0, ...before.map(p => p.position))

    const normal = await createPrompt({
      title: `E2E normal ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused',
    })
    assert.equal(normal.status, 201)
    created.push(normal.body.id)
    assert.ok(normal.body.position > maxPos,
      `sans priorité, la position (${normal.body.position}) doit dépasser le maximum existant (${maxPos})`)

    const prio = await createPrompt({
      title: `E2E prio API ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', priority: true,
    })
    assert.equal(prio.status, 201)
    created.push(prio.body.id)
    assert.ok(prio.body.position < normal.body.position,
      `avec priorité, la position (${prio.body.position}) doit précéder celle d'un item normal (${normal.body.position})`)

    // Et l'ordre rendu par le serveur suit : le prioritaire avant le normal.
    const ids = (await listPrompts()).map(p => p.id)
    assert.ok(ids.indexOf(prio.body.id) < ids.indexOf(normal.body.id), 'ordre de la file non respecté')
  })
})
