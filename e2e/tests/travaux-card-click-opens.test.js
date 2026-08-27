// Travaux — toute la boîte blanche d'une tâche ouvre la conversation.
//
// Signalement : il fallait viser la flèche ou le texte d'aperçu pour ouvrir une
// carte de la file ou des conversations. Désormais un clic n'importe où dans la
// boîte blanche (ligne repliée) ouvre/replie — sauf sur un contrôle (bouton,
// champ, poignée), qui garde son comportement propre.
//
// Vérifie :
//   1. File : clic sur la pastille de statut (zone « inerte » avant) → la carte
//      s'ouvre ; re-clic → elle se replie.
//   2. File : clic sur le champ titre (item modifiable) → PAS de toggle (le champ
//      sert à éditer).
//   3. Conversations : clic sur le titre (simple texte) d'une tâche terminée →
//      la conversation s'ouvre.
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

const MARKER = `E2E carte cliquable ${Date.now()}`

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

describe('Travaux — carte cliquable en entier', () => {
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
    // Item jetable « de côté » : jamais démarré par l'ordonnanceur.
    const created = await api(page, 'POST', '/travaux/prompts', {
      prompt: `${MARKER} — corps du prompt de test, ne pas exécuter.`,
      title: MARKER,
      status: 'paused',
    })
    promptId = created.id
    assert.ok(promptId, 'création de l\'item de test')
  })

  after(async () => {
    try { if (promptId) await api(page, 'DELETE', `/travaux/prompts/${promptId}`) } catch {}
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('file : clic sur la pastille de statut → ouvre, re-clic → replie', async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 15000 })
    assert.equal(await card.getAttribute('data-prompt-open'), '0', 'carte repliée au départ')

    // La pastille « De côté » était une zone inerte : elle doit maintenant ouvrir.
    await card.locator('[data-testid="travaux-row-head"] span:has-text("De côté")').first().click()
    await page.waitForFunction(id =>
      document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptOpen === '1', promptId, { timeout: 5000 })

    // Re-clic au même endroit → replie.
    await card.locator('[data-testid="travaux-row-head"] span:has-text("De côté")').first().click()
    await page.waitForFunction(id =>
      document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptOpen === '0', promptId, { timeout: 5000 })
  })

  test('file : clic sur le champ titre (édition) → ne toggle pas', async () => {
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.locator(`[data-testid="travaux-row-head"] input[value="${MARKER}"]`).click()
    // Petit délai : un toggle fautif serait immédiat.
    await page.waitForTimeout(400)
    assert.equal(await card.getAttribute('data-prompt-open'), '0',
      'cliquer le champ titre sert à éditer, pas à ouvrir')
  })

  test('conversations : clic sur le titre d\'une tâche terminée → ouvre', async () => {
    // Basculer l'item en « annulé » : il passe dans la vue Conversations.
    await api(page, 'PATCH', `/travaux/prompts/${promptId}`, { status: 'cancelled' })
    await page.goto(URL + '/travaux', { waitUntil: 'networkidle' })
    await page.click('[data-testid="travaux-view-conversations"]')
    // L'historique est paginé (15 cartes) : la recherche isole l'item de test.
    await page.fill('[data-testid="travaux-search"]', MARKER)
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 15000 })
    assert.equal(await card.getAttribute('data-prompt-open'), '0', 'carte repliée au départ')

    // Titre = simple texte (non modifiable) : le clic doit ouvrir la conversation.
    await card.locator(`[data-testid="travaux-row-head"] span:has-text("${MARKER}")`).first().click()
    await page.waitForFunction(id =>
      document.querySelector(`[data-prompt-id="${id}"]`)?.dataset.promptOpen === '1', promptId, { timeout: 5000 })
    // Le prompt de la tâche est bien visible dans le panneau ouvert.
    await card.locator('pre:has-text("corps du prompt de test")').waitFor({ timeout: 5000 })
  })
})
