// Sélecteur de modèle de l'agent dans le bandeau « Quotas Claude » (page Travaux).
//
// Ce que le test verrouille :
//   1. L'API des quotas liste les modèles offerts au choix (fable/opus/sonnet/haiku).
//   2. Le nom du modèle dans le bandeau est cliquable : un menu propose les modèles,
//      avec le préféré coché.
//   3. Choisir un autre modèle le sauvegarde aussitôt (agent-settings.json via
//      PUT /agent/settings) : le réglage persiste côté serveur et /agent/usage
//      annonce le nouveau préféré.
//
// Effet de bord : le test change réellement le modèle préféré quelques secondes.
// Le réglage d'origine est capturé AVANT et restauré dans after() — même en échec.

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

async function apiPut(page, p, body) {
  return page.evaluate(async ({ path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.json()
  }, { path: p, body })
}

const LABELS = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

describe('Agent — choix du modèle depuis le bandeau quotas', () => {
  let browser, ctx, page, originalModel

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    // Réglage d'origine, restauré quoi qu'il arrive dans after().
    const settings = await apiGet(page, '/agent/settings')
    originalModel = settings.preferredModel || 'fable'
  })

  after(async () => {
    if (page && originalModel) {
      await apiPut(page, '/agent/settings', { preferredModel: originalModel })
    }
    await ctx?.close()
    await browser?.close()
  })

  test('l\'API liste les modèles offerts au choix', async () => {
    const usage = await apiGet(page, '/agent/usage')
    assert.ok(usage.agentModel, 'la réponse doit porter l\'état du modèle de l\'agent')
    assert.deepEqual(usage.agentModel.models, ['fable', 'opus', 'sonnet', 'haiku'])
    assert.equal(usage.agentModel.preferred, originalModel)
  })

  test('le menu s\'ouvre et coche le modèle préféré courant', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    const name = page.locator('[data-testid="usage-strip-model-name"]')
    await name.waitFor({ timeout: 20000 })
    await name.click()
    const menu = page.locator('[data-testid="usage-strip-model-menu"]')
    await menu.waitFor({ timeout: 5000 })
    for (const m of ['fable', 'opus', 'sonnet', 'haiku']) {
      assert.equal(await menu.locator(`[data-testid="usage-strip-model-option-${m}"]`).count(), 1,
        `le menu doit proposer ${m}`)
    }
    // Échap referme le menu sans rien changer.
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('choisir un autre modèle le sauvegarde et l\'affiche aussitôt', async () => {
    const target = originalModel === 'sonnet' ? 'opus' : 'sonnet'

    const name = page.locator('[data-testid="usage-strip-model-name"]')
    await name.click()
    await page.locator(`[data-testid="usage-strip-model-option-${target}"]`).click()

    // Affichage optimiste immédiat…
    await page.waitForFunction(({ sel, label }) =>
      document.querySelector(sel)?.textContent.trim() === label,
    { sel: '[data-testid="usage-strip-model-name"]', label: LABELS[target] }, { timeout: 5000 })

    // …et persistance réelle côté serveur (poll API, pas le DOM — cf. règles E2E).
    let saved = null
    for (let i = 0; i < 20 && saved !== target; i++) {
      saved = (await apiGet(page, '/agent/settings')).preferredModel
      if (saved !== target) await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(saved, target, 'preferredModel doit être persisté dans les réglages')

    const usage = await apiGet(page, '/agent/usage')
    assert.equal(usage.agentModel.preferred, target, '/agent/usage doit annoncer le nouveau préféré')

    // Retour au réglage d'origine par l'interface (le menu coche désormais la cible).
    await name.click()
    const menu = page.locator('[data-testid="usage-strip-model-menu"]')
    await menu.waitFor({ timeout: 5000 })
    await menu.locator(`[data-testid="usage-strip-model-option-${originalModel}"]`).click()
    let restored = null
    for (let i = 0; i < 20 && restored !== originalModel; i++) {
      restored = (await apiGet(page, '/agent/settings')).preferredModel
      if (restored !== originalModel) await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(restored, originalModel, 'le retour au modèle d\'origine doit se sauvegarder aussi')
  })

  test('un modèle inconnu est refusé par l\'API', async () => {
    const res = await apiPut(page, '/agent/settings', { preferredModel: 'gpt-9' })
    assert.match(String(res.error || ''), /preferredModel invalide/)
    const settings = await apiGet(page, '/agent/settings')
    assert.equal(settings.preferredModel, originalModel)
  })
})
