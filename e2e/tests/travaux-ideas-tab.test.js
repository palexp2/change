// Travaux — onglet « Idées » (carnet).
//
// Une idée n'est pas une tâche : « The Future of ERP Systems » traînait dans la
// file de prompts, où tout est destiné à partir en exécution. Ce test couvre le
// nouvel onglet : créer une idée, la renommer en autosave, et la « passer à
// l'action » — l'item de file créé doit arriver DE CÔTÉ (paused), pour qu'une
// idée ne lance jamais Claude toute seule.
//
// Aucun record réel n'est touché : le test crée sa propre idée (titre horodaté)
// et supprime, dans after(), l'idée ET l'item de file issu de la promotion.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const IDEA_TITLE = `E2E idée ${STAMP}`
const IDEA_RENAMED = `E2E idée renommée ${STAMP}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}
const apiGet = (page, p) => apiFetch(page, 'GET', p)

/**
 * Attend qu'une condition serveur soit vraie (l'autosave est asynchrone). Délai
 * large à dessein : l'ERP de prod écrit pendant qu'une exécution d'agent tourne,
 * et un POST peut prendre plusieurs secondes sans que rien ne soit cassé.
 */
async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

describe('Travaux — carnet d\'idées', () => {
  let browser, ctx, page
  let ideaId = null
  let promotedPromptId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    // Nettoyage : l'item de file d'abord (il n'existe qu'à cause du test), puis
    // l'idée. Les deux passent par l'API — écritures sérialisées côté serveur.
    if (page) {
      if (promotedPromptId) await apiFetch(page, 'DELETE', `/travaux/prompts/${promotedPromptId}`)
      if (ideaId) await apiFetch(page, 'DELETE', `/travaux/ideas/${ideaId}`)
    }
    await browser?.close()
  })

  test('l\'onglet Idées existe et part vide de toute exécution', async () => {
    await page.goto(URL + '/travaux?onglet=idees', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="idea-title-input"]', { timeout: 15000 })
    assert.ok(await page.locator('button:has-text("Idées")').first().isVisible(), 'onglet Idées visible')
    assert.match(
      await page.locator('text=Rien ne s\'exécute depuis les idées').first().innerText(),
      /relues/,
      'la promesse « rien ne s\'exécute » est affichée',
    )
  })

  test('créer une idée, avec son développement', async () => {
    await page.fill('[data-testid="idea-title-input"]', IDEA_TITLE)
    await page.fill('textarea[placeholder^="Développer (facultatif)"]', 'Idée de test E2E — à supprimer.')
    await page.click('[data-testid="idea-add"]')

    const created = await waitFor(async () => {
      const { ideas } = await apiGet(page, '/travaux/ideas')
      return ideas.find(i => i.title === IDEA_TITLE) || null
    }, { label: 'idée créée' })
    ideaId = created.id
    assert.equal(created.notes, 'Idée de test E2E — à supprimer.')

    // Et elle est bien rendue dans la liste.
    await page.waitForSelector(`[data-idea-id="${ideaId}"]`, { timeout: 20000 })
  })

  test('renommer l\'idée s\'enregistre sans bouton (autosave)', async () => {
    const card = page.locator(`[data-idea-id="${ideaId}"]`)
    const title = card.locator('input').first()
    await title.fill(IDEA_RENAMED)
    await title.blur()

    await waitFor(async () => {
      const { ideas } = await apiGet(page, '/travaux/ideas')
      return ideas.find(i => i.id === ideaId)?.title === IDEA_RENAMED
    }, { label: 'titre sauvegardé' })
  })

  test('passer à l\'action crée un item de file MIS DE CÔTÉ (rien ne démarre)', async () => {
    await page.locator(`[data-idea-id="${ideaId}"] [data-testid="idea-promote"]`).click()

    const promoted = await waitFor(async () => {
      const { prompts } = await apiGet(page, '/travaux/prompts')
      return prompts.find(p => p.title === IDEA_RENAMED) || null
    }, { label: 'item de file créé' })
    promotedPromptId = promoted.id
    assert.equal(promoted.status, 'paused', 'l\'item arrive de côté, jamais lancé d\'office')
    assert.equal(promoted.agent_task_id, null, 'aucune tâche agent déclenchée')

    // L'idée garde le lien : promouvoir deux fois ne duplique pas l'item.
    await waitFor(async () => {
      const { ideas } = await apiGet(page, '/travaux/ideas')
      return ideas.find(i => i.id === ideaId)?.work_prompt_id === promotedPromptId
    }, { label: 'lien idée → item de file' })

    const again = await apiFetch(page, 'POST', `/travaux/ideas/${ideaId}/promote`, {})
    assert.equal(again.already, true)
    assert.equal(again.prompt.id, promotedPromptId)
  })

  test('retirer une idée la fait disparaître de la liste', async () => {
    // Idée jetable dédiée : le record principal sert encore au nettoyage.
    const throwaway = await apiFetch(page, 'POST', '/travaux/ideas', { title: `E2E idée jetable ${STAMP}` })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-idea-id="${throwaway.id}"]`, { timeout: 15000 })
    await page.locator(`[data-idea-id="${throwaway.id}"] [data-testid="idea-delete"]`).click()
    await page.waitForSelector(`[data-idea-id="${throwaway.id}"]`, { state: 'detached', timeout: 10000 })

    const { ideas } = await apiGet(page, '/travaux/ideas')
    assert.equal(ideas.some(i => i.id === throwaway.id), false, 'supprimée côté serveur aussi')
  })
})
