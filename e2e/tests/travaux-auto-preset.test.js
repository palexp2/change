// Travaux → préréglage « Auto » : le calibre (Rapide/Standard/Approfondi) est
// jugé automatiquement selon la tâche, comme le titre.
//
// Couvre :
//   - le composeur n'affiche aucun sélecteur de calibre et crée toujours en auto ;
//   - créer avec preset:'auto' pose preset_auto=1 et un calibre provisoire sûr
//     (standard pour une question, approfondi pour une implémentation) ;
//   - choisir un calibre concret fige (preset_auto=0), revenir à « Auto » le rend
//     au jugement automatique ;
//   - la carte d'un item auto affiche « Auto » dans son sélecteur.
//
// Sécurité : aucune exécution réelle de l'agent.
//   - test UI : la création est interceptée et forcée en `status:paused` +
//     `mode:question` avant d'atteindre le serveur — l'ordonnanceur ne ramasse
//     jamais un item « de côté ».
//   - tests API : items créés directement en pause.
// La classification modèle asynchrone est best-effort : on ne l'attend pas (elle
// peut réécrire le provisoire quelques secondes plus tard, jamais un choix manuel).
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — préréglage automatique (Auto)', () => {
  let browser, ctx, page
  const stamp = Date.now()
  const created = []       // ids à supprimer en fin de test

  const api = (fn, arg) => page.evaluate(fn, arg)

  const createPrompt = (body) => api(async (body) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api/travaux/prompts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }, body)

  const patchPrompt = (arg) => api(async ({ id, patch }) => {
    const token = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api/travaux/prompts/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return { status: r.status, body: await r.json() }
  }, arg)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Garde-fou : toute création partie de cette page est déposée « de côté » —
    // l'ordonnanceur ne ramasse jamais un item en pause, quel que soit son mode.
    // Le mode explicite est préservé (le test du provisoire en dépend).
    await page.route('**/api/travaux/prompts', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const sent = JSON.parse(route.request().postData() || '{}')
      await route.continue({
        postData: JSON.stringify({ ...sent, status: 'paused' }),
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

  // Le calibre étant toujours jugé automatiquement, le composeur ne montre plus
  // de sélecteur : ce qui part de là doit néanmoins arriver en auto côté serveur.
  test('le composeur n\'affiche plus de sélecteur de calibre et crée en auto', async () => {
    // Le composeur n'a plus de champ « Titre » (déduit du prompt côté serveur) :
    // c'est le prompt, horodaté, qui identifie l'item du test.
    const composerPrompt = `Ne rien faire — item de test E2E ${stamp} (composeur).`
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 20000 })
    await page.click('[data-testid="travaux-new-prompt"]')
    await page.waitForSelector('[data-testid="travaux-new-submit"]', { timeout: 10000 })
    assert.equal(await page.locator('[data-testid="travaux-new-preset"]').count(), 0,
      'le composeur ne doit plus offrir de sélecteur de calibre')

    await page.fill('textarea[placeholder^="Décris la tâche"]', composerPrompt)
    // Dépôt « de côté » : l'ordonnanceur ne ramasse jamais un item en pause.
    await page.click('[data-testid="travaux-new-aside"]')

    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const { prompts } = await api(async () => {
        const token = localStorage.getItem('erp_token')
        const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
        return r.json()
      })
      row = prompts.find(p => p.prompt === composerPrompt) || null
      if (!row) await new Promise(r2 => setTimeout(r2, 300))
    }
    assert.ok(row, 'l\'item créé depuis le composeur doit apparaître')
    created.push(row.id)
    assert.equal(row.preset_auto, 1, 'une création depuis le composeur doit rester en auto')
  })

  test('créer en auto : flag posé et calibre provisoire sûr', async () => {
    // Question → provisoire « standard ».
    const q = await createPrompt({
      title: `E2E auto question ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', preset: 'auto',
    })
    assert.equal(q.status, 201)
    created.push(q.body.id)
    assert.equal(q.body.preset_auto, 1, 'preset_auto doit être posé')
    assert.equal(q.body.preset, 'standard', 'provisoire d\'une question = standard')

    // Implémentation → provisoire « deep » (l'item reste en pause : rien ne part).
    const impl = await createPrompt({
      title: `E2E auto implement ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'implement', status: 'paused', preset: 'auto',
    })
    assert.equal(impl.status, 201)
    created.push(impl.body.id)
    assert.equal(impl.body.preset_auto, 1)
    assert.equal(impl.body.preset, 'deep', 'provisoire d\'une implémentation = approfondi')

    // Un calibre explicite, lui, reste figé.
    const fixed = await createPrompt({
      title: `E2E preset figé ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', preset: 'fast',
    })
    assert.equal(fixed.status, 201)
    created.push(fixed.body.id)
    assert.equal(fixed.body.preset_auto, 0, 'un choix explicite ne doit pas être auto')
    assert.equal(fixed.body.preset, 'fast')

    // Valeur inconnue refusée.
    const bad = await createPrompt({
      title: `E2E preset invalide ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', preset: 'turbo',
    })
    assert.equal(bad.status, 400)
    if (bad.body?.id) created.push(bad.body.id)
  })

  test('choisir un calibre fige, revenir à Auto le rend au jugement', async () => {
    const { body: p } = await createPrompt({
      title: `E2E auto bascule ${stamp}`, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', preset: 'auto',
    })
    created.push(p.id)

    const manual = await patchPrompt({ id: p.id, patch: { preset: 'fast' } })
    assert.equal(manual.status, 200)
    assert.equal(manual.body.preset, 'fast')
    assert.equal(manual.body.preset_auto, 0, 'un choix manuel doit figer le calibre')

    const backAuto = await patchPrompt({ id: p.id, patch: { preset: 'auto' } })
    assert.equal(backAuto.status, 200)
    assert.equal(backAuto.body.preset_auto, 1, 'revenir à Auto doit rendre le choix au modèle')
    assert.ok(['fast', 'standard', 'deep'].includes(backAuto.body.preset),
      'preset doit rester une clé concrète (exécutable) même en auto')
  })

  test('la carte d\'un item auto affiche « Auto » dans son sélecteur', async () => {
    const title = `E2E auto carte ${stamp}`
    const { body: p } = await createPrompt({
      title, prompt: 'Ne rien faire — item de test E2E.',
      mode: 'question', status: 'paused', preset: 'auto',
    })
    created.push(p.id)

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const card = page.locator(`[data-prompt-id="${p.id}"]`)
    await card.waitFor({ timeout: 20000 })
    await card.locator('[data-testid="travaux-toggle"]').click()
    const select = card.locator('[data-testid="travaux-preset"]')
    await select.waitFor({ timeout: 10000 })
    assert.equal(await select.inputValue(), 'auto', 'le sélecteur de la carte doit afficher Auto')

    // Choisir un calibre concret depuis la carte fige côté serveur.
    await select.selectOption('standard')
    let row = null
    for (let i = 0; i < 40; i++) {
      const r = await patchPrompt({ id: p.id, patch: {} })   // GET-like : PATCH vide rend la ligne
      row = r.body
      if (row.preset === 'standard' && row.preset_auto === 0) break
      await new Promise(r2 => setTimeout(r2, 300))
    }
    assert.equal(row.preset, 'standard')
    assert.equal(row.preset_auto, 0, 'le choix fait depuis la carte doit figer le calibre')
  })
})
