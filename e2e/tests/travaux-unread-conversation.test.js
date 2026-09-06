// Travaux — conversations terminées « à lire » façon boîte mail.
//
// Signalement : trop de conversations terminées dans /travaux, impossible de
// distinguer celles déjà consultées de celles qui ne l'ont pas encore été.
//
// Vérifie :
//   1. Une tâche qui vient de se terminer (annulée dans ce test — même famille
//      d'état que done/blocked côté carte) s'affiche en gras et avec un repère
//      « non lu » (data-prompt-unread=1) dans la vue Conversations.
//   2. L'ouvrir marque la conversation lue (seen_at posé côté serveur) : le repère
//      disparaît et le titre repasse en poids normal — persistant après reload.
//
// L'agent est forcé OFF (capturé/restauré en after()) : l'item créé est « de
// côté » puis « annulé », rien ne s'exécute. Cleanup : item supprimé via l'API.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E conversation non lue ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

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

describe('Travaux — conversation terminée non lue', () => {
  let browser, ctx, page
  let originalEnabled = false
  let promptId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await api(page, 'PUT', '/agent/settings', { enabled: false })
    const created = await api(page, 'POST', '/travaux/prompts', {
      prompt: `${MARKER} — corps du prompt de test, ne pas exécuter.`,
      title: MARKER,
      status: 'paused',
    })
    promptId = created.id
    assert.ok(promptId, 'création de l\'item de test')
    // Passe l'item en « terminé » (cancelled) sans jamais l'ouvrir dans l'UI :
    // c'est l'état « à lire » qu'on veut observer.
    await api(page, 'PATCH', `/travaux/prompts/${promptId}`, { status: 'cancelled' })
  })

  after(async () => {
    try { if (promptId) await api(page, 'DELETE', `/travaux/prompts/${promptId}`) } catch {}
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('non lue au départ : gras + repère, puis marquée lue à l\'ouverture', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    await page.click('[data-testid="travaux-view-conversations"]')
    await page.fill('[data-testid="travaux-search"]', MARKER)

    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 15000 })
    assert.equal(await card.getAttribute('data-prompt-unread'), '1', 'la conversation doit démarrer « non lue »')
    const title = card.locator('[data-testid="travaux-title"]')
    await title.waitFor({ timeout: 5000 })
    assert.match(await title.evaluate(el => getComputedStyle(el).fontWeight), /^(700|bold)$/,
      'titre en gras tant que non lue')

    // Ouverture de la conversation → marquée lue.
    await title.click()
    await page.waitForFunction(id =>
      document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptOpen === '1', promptId, { timeout: 5000 })
    await page.waitForFunction(id =>
      document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptUnread === '0', promptId, { timeout: 5000 })

    // Persiste après reload (seen_at posé côté serveur, pas seulement en mémoire).
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    await page.click('[data-testid="travaux-view-conversations"]')
    await page.fill('[data-testid="travaux-search"]', MARKER)
    const cardAfterReload = page.locator(`[data-prompt-id="${promptId}"]`)
    await cardAfterReload.waitFor({ timeout: 15000 })
    assert.equal(await cardAfterReload.getAttribute('data-prompt-unread'), '0',
      'reste marquée lue après un rechargement')
  })
})
