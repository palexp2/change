// Bulle « Modifier le système » (FeedbackFab) + panneau rapide : bouton discret
// « Au début / À la fin de la file ».
//
// Avant : une demande déposée depuis la bulle partait TOUJOURS en fin de file,
// sans aucun moyen de la faire passer devant. Le bouton de placement (partagé
// avec la page /travaux — lib/travauxQueue.jsx) donne le choix à l'envoi.
//
// Sécurité : aucune exécution réelle de l'agent.
//   - l'agent est forcé OFF (état capturé puis restauré en after) ;
//   - la requête de création est interceptée et forcée en `status:paused` +
//     `mode:question` — l'ordonnanceur ne ramasse jamais un item « de côté ».
// Nettoyage : l'item créé est supprimé en after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }, { method, path: p, body })
}

describe('Placement dans la file — bulle « Modifier le système » et panneau rapide', () => {
  let browser, ctx, page
  let originalEnabled = false
  let promptId = null
  let sentBody = null
  const stamp = Date.now()

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })

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
    try { if (promptId && page) await api(page, 'DELETE', `/travaux/prompts/${promptId}`) } catch { /* nettoyage best-effort */ }
    try { if (page) await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch { /* idem */ }
    await browser?.close()
  })

  test('la bulle propose le placement, « à la fin » par défaut', async () => {
    await page.goto(URL + '/interactions', { waitUntil: 'networkidle' })
    await page.click('[data-testid="feedback-fab"]')
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })

    const btn = page.locator('[data-testid="feedback-placement"]')
    await btn.waitFor({ timeout: 5000 })
    assert.equal(await btn.getAttribute('data-placement'), 'last', 'défaut : fin de file')
    assert.match(await btn.innerText(), /fin de la file/i)
  })

  test('basculer sur « Au début » envoie priority et dépose l\'item devant la file', async () => {
    const btn = page.locator('[data-testid="feedback-placement"]')
    await btn.click()
    assert.equal(await btn.getAttribute('data-placement'), 'first')
    assert.match(await btn.innerText(), /début de la file/i)

    const text = `E2E placement ${stamp} : ne rien faire, item de test.`
    await page.fill('[data-testid="feedback-fab-text"]', text)
    await page.click('[data-testid="feedback-fab-submit"]')
    // Pas d'écran de confirmation : la modale se referme dès le dépôt.
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { state: 'detached', timeout: 10000 })

    assert.equal(sentBody?.priority, true, 'priority absent du payload de création')

    const { prompts } = await api(page, 'GET', '/travaux/prompts')
    const mine = (prompts || []).find(p => (p.prompt || '').includes(text))
    assert.ok(mine, 'l\'item doit exister côté API')
    promptId = mine.id
    assert.equal(mine.status, 'paused', 'garde-fou : l\'item de test doit rester de côté')

    // Devant tous les items qui attendent leur tour.
    for (const q of (prompts || []).filter(p => p.status === 'queued')) {
      assert.ok(mine.position < q.position,
        `l'item prioritaire (${mine.position}) devrait précéder « ${q.title} » (${q.position})`)
    }
  })

  test('le panneau rapide offre le même bouton', async () => {
    // La modale s'est refermée toute seule à l'envoi — rien à fermer ici.
    await page.waitForSelector('[data-testid="feedback-fab"]', { timeout: 5000 })
    await page.goto(URL + '/interactions', { waitUntil: 'networkidle' })
    await page.click('[data-testid="travaux-quick-button"]')
    await page.waitForSelector('[data-testid="travaux-quick-input"]', { timeout: 10000 })

    const btn = page.locator('[data-testid="travaux-quick-priority"]')
    await btn.waitFor({ timeout: 5000 })
    assert.equal(await btn.getAttribute('data-placement'), 'last')
    await btn.click()
    assert.equal(await btn.getAttribute('data-placement'), 'first', 'le bouton bascule vers le début de file')
    // Rien n'est envoyé depuis le panneau : la bascule suffit, le chemin serveur
    // est déjà couvert plus haut. On referme pour laisser l'app propre.
    await page.click('[data-testid="travaux-quick-close"]')
  })
})
