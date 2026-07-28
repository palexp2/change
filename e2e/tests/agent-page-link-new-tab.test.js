// Agent autonome — le bouton « Voir la page » ouvre un NOUVEL onglet.
//
// Sur les cartes de suggestion complétées (/agent), le lien « Voir la page »
// naviguait dans l'onglet courant, faisant perdre le contexte de la page agent.
// Ce test vérifie que le lien porte target="_blank" et qu'un clic ouvre bien
// un nouvel onglet sur la route concernée, sans quitter /agent.
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). Seed via
// POST /agent/backlog (crée l'item + la tâche liée, sans proposition instantanée)
// puis PATCH de la tâche en « done ». Cleanup + toggle restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_TEXT = `E2E voir-la-page nouvel onglet ${Date.now()}`
const SEED_CONTEXT = '/factures'

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

describe('Agent — « Voir la page » ouvre un nouvel onglet', () => {
  let browser, ctx, page
  let originalEnabled = false
  let backlogId = null
  let taskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiFetch(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // POST /backlog crée l'item + approuve immédiatement → tâche liée (approved).
    // Agent OFF : aucune exécution ne démarre. On passe la tâche en « done » pour
    // faire apparaître le lien « Voir la page » sur la carte.
    const item = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_TEXT, context: SEED_CONTEXT })
    backlogId = item.id
    taskId = item.task_id
    assert.ok(taskId, 'la tâche liée doit exister après POST /agent/backlog')
    const now = new Date().toISOString()
    await apiFetch(page, 'PATCH', `/agent/tasks/${taskId}`, {
      status: 'done', started_at: now, completed_at: now,
      user_summary: 'Seed E2E — implémentation simulée.',
    })
  })

  after(async () => {
    try { if (backlogId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${backlogId}`) } catch {}
    try { if (taskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le lien porte target=_blank et le clic ouvre la route dans un nouvel onglet', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    // La carte de suggestion seedée, avec son lien « Voir la page ».
    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_TEXT })
    await card.waitFor({ timeout: 10000 })
    const link = card.getByTestId('card-page-link')
    await link.waitFor({ timeout: 5000 })

    assert.equal(await link.getAttribute('target'), '_blank', 'le lien doit avoir target="_blank"')
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer', 'rel de sécurité attendu')

    // Le clic doit ouvrir un nouvel onglet sur la route du contexte…
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 10000 }),
      link.click(),
    ])
    await popup.waitForLoadState('domcontentloaded')
    assert.ok(popup.url().includes('/erp' + SEED_CONTEXT), `nouvel onglet attendu sur /erp${SEED_CONTEXT}, obtenu : ${popup.url()}`)
    await popup.close()

    // …sans quitter la page agent dans l'onglet d'origine.
    assert.ok(page.url().includes('/agent'), 'l\'onglet d\'origine doit rester sur /agent')
  })
})
