// Travaux → titre automatique discret : une carte dont le titre a été généré
// automatiquement ne doit RIEN annoncer à l'écran (ni libellé, ni infobulle
// « Titre automatique… »). La fonctionnalité reste : écrire un titre le fige, et
// une carte au titre figé garde son indication pour retrouver le mode auto.
//
// Sécurité : AUCUN record réel — la liste des prompts est entièrement interceptée
// (deux cartes factices en pause), et tout PATCH éventuel vers ces ids est
// court-circuité avant d'atteindre le serveur.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const base = {
  prompt: 'Ne rien faire — carte factice E2E.',
  mode: 'implement', preset: 'deep', preset_auto: 0, same_context: 0, stop_after: 0,
  status: 'paused', run_state: null, pending_question: null, user_summary: null,
  agent_status: null, lane: 'exec', wait_rank: null, follow_up: 0, space: 'finance',
  created_at: '2026-08-04T00:00:00.000Z', started_at: null, completed_at: null,
  messages: [],
}
const AUTO = { ...base, id: 'e2e-titre-auto', title: 'E2E titre généré automatiquement', title_auto: 1, position: 1 }
const FIGE = { ...base, id: 'e2e-titre-fige', title: 'E2E titre figé à la main', title_auto: 0, position: 2 }

describe('Travaux — titre automatique sans mention à l\'écran', () => {
  let browser, ctx, page
  const patched = []          // PATCH envoyés vers les cartes factices (interceptés)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Liste interceptée : rien n'est écrit en base, aucune exécution possible.
    await page.route('**/api/travaux/prompts*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [AUTO, FIGE], agent_enabled: true, runner_busy: false,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
    await page.route('**/api/travaux/prompts/e2e-*', async (route) => {
      const req = route.request()
      if (req.method() === 'PATCH') patched.push(req.postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTO) })
    })

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-prompt-id="e2e-titre-auto"]', { timeout: 15000 })
  })

  after(async () => {
    await page?.unroute('**/api/travaux/prompts*').catch(() => {})
    await page?.unroute('**/api/travaux/prompts/e2e-*').catch(() => {})
    await browser?.close()
  })

  test('titre auto : aucun libellé ni infobulle « Titre automatique » sur la carte', async () => {
    const card = page.locator('[data-prompt-id="e2e-titre-auto"]')
    const input = card.locator(`input[value="${AUTO.title}"]`)
    await input.waitFor({ timeout: 5000 })

    // Pas d'infobulle qui annonce le titre automatique…
    const tooltip = await input.getAttribute('title')
    assert.equal(tooltip, null, `le champ titre ne doit porter aucune infobulle (reçu : « ${tooltip} »)`)
    // …ni aucun texte « titre auto(matique) » nulle part sur la carte.
    const text = await card.innerText()
    assert.doesNotMatch(text.toLowerCase(), /titre\s*auto/, 'aucune mention « titre auto » ne doit être visible')
  })

  test('titre figé : l\'indication pour revenir au mode automatique est conservée', async () => {
    const card = page.locator('[data-prompt-id="e2e-titre-fige"]')
    const input = card.locator(`input[value="${FIGE.title}"]`)
    await input.waitFor({ timeout: 5000 })
    assert.equal(await input.getAttribute('title'),
      'Titre figé — vide le champ pour revenir au titre automatique',
      'un titre écrit à la main doit garder son indication de retour au mode auto')
  })

  test('la carte au titre auto reste éditable : écrire un titre part bien au serveur', async () => {
    // La fonctionnalité doit survivre au retrait du libellé : le champ titre est
    // toujours un input éditable, et la saisie déclenche l'autosave (qui figerait
    // le titre côté serveur). Le PATCH est intercepté — rien n'atteint la base.
    const card = page.locator('[data-prompt-id="e2e-titre-auto"]')
    const input = card.locator(`input[value="${AUTO.title}"]`)
    assert.equal(await input.isEditable(), true, 'le titre doit rester éditable en place')
    await input.fill('Mon titre à moi')
    await input.blur()
    for (let i = 0; i < 25 && !patched.some(p => p.title); i++) await new Promise(r => setTimeout(r, 200))
    assert.ok(patched.some(p => p.title === 'Mon titre à moi'),
      'la saisie d\'un titre doit être envoyée au serveur (c\'est elle qui fige le titre)')
  })
})
