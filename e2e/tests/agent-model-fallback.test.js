// Modèle de l'agent autonome : Fable, avec repli automatique sur Opus.
//
// Ce que le test verrouille :
//   1. L'API des quotas annonce bien le modèle de travail de l'agent — Fable préféré,
//      Opus en repli — et un modèle ACTIF (celui qui tourne réellement).
//   2. La page Travaux l'affiche : « Modèle Fable » dans le bandeau des quotas. Sans ça,
//      un repli sur Opus passait totalement inaperçu.
//   3. Le repli lui-même s'affiche correctement : payload interceptée (impossible
//      d'épuiser un vrai quota hebdomadaire dans un test), on vérifie que l'interface
//      montre « Opus (repli) » et explique que la file avance quand même — et surtout
//      qu'elle ne prétend PAS que la file est en pause.
//
// Lecture seule : aucun record créé, aucun réglage modifié, aucun quota consommé.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiGet(page, p) {
  return page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}

describe('Agent — modèle Fable et repli Opus', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await ctx?.close()
    await browser?.close()
  })

  test('l\'API annonce Fable comme modèle de l\'agent, Opus en repli', async () => {
    const usage = await apiGet(page, '/agent/usage')
    assert.ok(usage.agentModel, 'la réponse doit porter l\'état du modèle de l\'agent')
    assert.equal(usage.agentModel.preferred, 'fable')
    assert.equal(usage.agentModel.fallback, 'opus')
    // Le modèle actif est Fable tant que son quota tient, Opus sinon — jamais autre chose.
    assert.ok(['fable', 'opus'].includes(usage.agentModel.active),
      `modèle actif inattendu: ${usage.agentModel.active}`)
    assert.equal(usage.agentModel.fallbackActive, usage.agentModel.active === 'opus')
    assert.ok(Array.isArray(usage.agentModel.limited))
  })

  test('la page Travaux affiche le modèle sur lequel l\'agent travaille', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    const name = page.locator('[data-testid="usage-strip-model-name"]')
    await name.waitFor({ timeout: 20000 })
    const shown = (await name.textContent()).trim()
    assert.ok(['Fable', 'Opus'].includes(shown), `libellé de modèle inattendu: « ${shown} »`)

    // État réel : le libellé doit correspondre à ce que dit l'API, pas à une valeur figée.
    const usage = await apiGet(page, '/agent/usage')
    const expected = usage.agentModel.active === 'opus' ? 'Opus' : 'Fable'
    assert.equal(shown, expected)
  })

  test('quota Fable épuisé : l\'interface annonce le repli sur Opus, PAS une pause', async () => {
    // On ne peut pas épuiser un plafond hebdomadaire réel dans un test : on interpose la
    // réponse des quotas pour ce chargement de page uniquement (aucun état serveur touché).
    const resetsAt = new Date(Date.now() + 36 * 3600_000).toISOString()
    await page.route('**/api/agent/usage', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.schedulerLimitResetAt = null
      body.weekScoped = { utilizationPct: 100, resetsAt, severity: 'normal', label: 'Fable' }
      body.agentModel = {
        preferred: 'fable',
        active: 'opus',
        fallback: 'opus',
        fallbackActive: true,
        preferredResetAt: resetsAt,
        limited: [{ model: 'fable', resetAt: resetsAt, source: 'usage' }],
      }
      await route.fulfill({ response: res, json: body })
    })

    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    const name = page.locator('[data-testid="usage-strip-model-name"]')
    await name.waitFor({ timeout: 20000 })
    assert.equal((await name.textContent()).trim(), 'Opus')
    await assert.doesNotReject(
      page.locator('[data-testid="usage-strip-model"]:has-text("(repli)")').waitFor({ timeout: 10000 }),
      'le repli doit être signalé à côté du nom du modèle',
    )

    const banner = page.locator('[data-testid="claude-usage-fallback"]')
    await banner.waitFor({ timeout: 10000 })
    const text = (await banner.textContent()).replace(/\s+/g, ' ')
    assert.match(text, /Plafond Fable épuisé/)
    assert.match(text, /continue sur Opus/)
    assert.match(text, /file avance normalement/)
    // Le message de pause forcée ne doit PAS apparaître : la file, justement, tourne.
    assert.equal(await page.locator('text=pause forcée').count(), 0)

    await page.unroute('**/api/agent/usage')
  })
})
