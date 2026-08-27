// Travaux — « Mettre de côté » au composeur, section « De côté » réunie avec les
// idées, et pastille « Claude » sur les items nés d'une suggestion.
//
// Ce qui est couvert :
//   1. le composeur de prompt a un second bouton « Mettre de côté » : l'item est
//      créé mais RANGÉ (status paused), jamais mis en file ;
//   2. l'onglet « De côté & idées » (?onglet=de-cote, alias de ?onglet=idees)
//      montre cet item dans sa section « De côté », au-dessus du carnet d'idées ;
//   3. depuis cette section, ▶︎ remet l'item en file (PATCH status=queued) ;
//   4. un item né d'une suggestion porte une pastille discrète « Claude ».
//
// Sécurité (voir CLAUDE.md / mémoire E2E) : le SEUL record réel est créé par le
// test lui-même, en « de côté » — l'ordonnanceur ne le ramasse jamais — et il est
// supprimé dans after(). Les tests 3 et 4 tournent entièrement sur une liste
// interceptée : aucun PATCH n'atteint le serveur, rien ne peut partir en exécution.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
// Le composeur n'a plus de champ « Titre » (déduit du prompt côté serveur) : c'est
// le prompt, horodaté, qui identifie l'item du test.
const PROMPT = `Test E2E ${STAMP} — ne rien faire, cet item est mis de côté puis supprimé.`

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

async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

// Cartes factices pour les tests 3 et 4 : jamais écrites en base.
const fixtureBase = {
  prompt: 'Ne rien faire — carte factice E2E.',
  mode: 'implement', preset: 'fast', preset_auto: 0, same_context: 0, stop_after: 0,
  status: 'paused', run_state: null, pending_question: null, user_summary: null,
  agent_status: null, lane: 'exec', wait_rank: null, follow_up: 0, space: 'finance',
  title_auto: 0, created_at: '2026-08-09T00:00:00.000Z', started_at: null,
  completed_at: null, messages: [],
}
const PLAIN = { ...fixtureBase, id: 'e2e-aside-plain', title: 'E2E carte de côté factice', position: 1 }
const FROM_CLAUDE = {
  ...fixtureBase, id: 'e2e-aside-claude', title: 'E2E carte issue d\'une suggestion',
  position: 2, suggestion_id: 'e2e-suggestion', suggestion_kind: 'integration', suggestion_area: 'comptabilite',
}

describe('Travaux — « De côté » (composeur, section, pastille Claude)', () => {
  let browser, ctx, page
  let createdId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    await page?.unroute('**/api/travaux/prompts/e2e-*').catch(() => {})
    await page?.unroute('**/api/travaux/prompts*').catch(() => {})
    if (page && createdId) await apiFetch(page, 'DELETE', `/travaux/prompts/${createdId}`)
    await browser?.close()
  })

  test('le composeur dépose un prompt DE CÔTÉ, sans le mettre en file', async () => {
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-new-prompt"]', { timeout: 20000 })
    await page.click('[data-testid="travaux-new-prompt"]')

    await page.fill('textarea[placeholder^="Décris la tâche"]', PROMPT)

    const aside = page.locator('[data-testid="travaux-new-aside"]')
    assert.equal(await aside.isVisible(), true, 'le bouton « Mettre de côté » doit exister au composeur')
    await aside.click()

    const created = await waitFor(async () => {
      const { prompts } = await apiGet(page, '/travaux/prompts')
      return prompts.find(p => p.prompt === PROMPT) || null
    }, { label: 'item créé' })
    createdId = created.id
    assert.equal(created.status, 'paused', 'le dépôt « de côté » ne doit jamais entrer en file')
    assert.equal(created.agent_task_id, null, 'aucune tâche agent ne doit être déclenchée')
  })

  test('l\'onglet « De côté & idées » montre l\'item rangé, au-dessus du carnet', async () => {
    // ?onglet=de-cote : alias de l'onglet des idées, qui héberge la section.
    await page.goto(URL + '/travaux?onglet=de-cote', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="travaux-aside-section"]', { timeout: 20000 })
    await page.waitForSelector(`[data-testid="travaux-aside-list"] [data-prompt-id="${createdId}"]`, { timeout: 20000 })

    // Les deux listes cohabitent bien sur le même onglet.
    assert.equal(await page.locator('[data-testid="idea-title-input"]').isVisible(), true,
      'le carnet d\'idées doit être sur le même onglet que « De côté »')
  })

  test('depuis la section, ▶︎ remet l\'item en file (et rien d\'autre ne part)', async () => {
    const patched = []
    // Deux motifs : `*` ne traverse pas les `/`, la liste et la carte ne peuvent
    // donc pas être interceptées par la même route.
    await page.route('**/api/travaux/prompts/e2e-*', async (route) => {
      const req = route.request()
      if (req.method() === 'PATCH') patched.push(req.postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...PLAIN, status: 'queued' }) })
    })
    await page.route('**/api/travaux/prompts*', async (route) => {
      const req = route.request()
      if (req.method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompts: [PLAIN, FROM_CLAUDE], agent_enabled: true, runner_busy: false,
          queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
          running_questions: 0, max_parallel_questions: 2,
        }),
      })
    })
    await page.goto(URL + '/travaux?onglet=de-cote', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-prompt-id="${PLAIN.id}"]`, { timeout: 20000 })

    await page.locator(`[data-prompt-id="${PLAIN.id}"] button[title="Remettre en file"]`).click()
    await waitFor(async () => patched.some(p => p.status === 'queued'), { timeout: 10000, label: 'PATCH status=queued' })
  })

  test('un item né d\'une suggestion porte une pastille discrète « Claude »', async () => {
    const badge = page.locator(`[data-prompt-id="${FROM_CLAUDE.id}"] [data-testid="travaux-suggestion-badge"]`)
    await badge.waitFor({ timeout: 10000 })
    assert.match(await badge.innerText(), /Claude/, 'la pastille doit nommer Claude')
    assert.match(await badge.getAttribute('title'), /Suggestion de Claude/, 'l\'infobulle détaille l\'origine')

    // …et une carte ordinaire n'en porte pas.
    assert.equal(
      await page.locator(`[data-prompt-id="${PLAIN.id}"] [data-testid="travaux-suggestion-badge"]`).count(), 0,
      'aucune pastille « Claude » sur un item saisi à la main')
  })
})
