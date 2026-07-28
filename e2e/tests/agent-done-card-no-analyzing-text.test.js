// Agent autonome — la carte d'une implémentation terminée ne doit plus afficher
// « L'agent analyse la demande et prépare une proposition… » quand on la déplie.
//
// Signalement utilisateur : les suggestions créées via POST /backlog sont
// auto-approuvées sans passer par la proposition instantanée, donc leur
// instant_status reste « generating » pour toujours. La fiche dépliée gatait le
// spinner d'analyse sur instant_status brut → il apparaissait même une fois la
// tâche implantée. Fix : gate sur le statut dérivé (suggestionStatus), qui donne
// priorité au statut de la tâche.
//
// L'agent est forcé OFF pour tout le run (aucun subprocess Claude). Seed/cleanup
// via l'API. Le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_DESC = `E2E carte terminée sans texte d'analyse ${Date.now()}`

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

describe('Agent autonome — carte terminée sans texte « analyse la demande »', () => {
  let browser, ctx, page
  let originalEnabled = false
  let seedId = null
  let seedTaskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed : POST /backlog auto-approuve → item avec instant_status 'generating'
    // (jamais mis à jour, c'est le scénario du bug) + tâche liée « approved ».
    const created = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_DESC })
    seedId = created.id
    seedTaskId = created.task_id || null
    assert.ok(seedTaskId, 'le POST /backlog doit créer une tâche liée')
    assert.equal(created.instant_status, 'generating', 'précondition du bug : instant_status resté generating')

    // Simule une implémentation complétée (pattern des seeds E2E existants).
    const now = new Date().toISOString()
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedTaskId}`, {
      status: 'done',
      user_summary: 'Résumé de test : le correctif a été implanté.',
      started_at: now,
      completed_at: now,
    })
  })

  after(async () => {
    try { if (seedId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${seedId}`) } catch {}
    try { if (seedTaskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedTaskId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('déplier une carte implantée ne montre pas le texte d\'analyse en cours', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DESC })
    await card.waitFor({ timeout: 5000 })

    // Statut affiché : « Implanté » (la tâche prime sur instant_status).
    const label = (await card.innerText()).replace(/\s+/g, ' ')
    assert.ok(label.includes('Implanté'), `la carte doit afficher « Implanté » (reçu: « ${label.slice(0, 200)} »)`)

    // Déplie la carte (clic sur l'en-tête) et attend le contenu déplié.
    await card.locator('.cursor-pointer').first().click()
    await card.locator('[data-testid="suggestion-user-summary"]').waitFor({ timeout: 5000 })

    // Le texte d'analyse ne doit plus apparaître.
    const analyzing = await card.locator('text=analyse la demande et prépare une proposition').count()
    assert.equal(analyzing, 0, 'le texte « L\'agent analyse la demande… » ne doit pas apparaître sur une carte terminée')
  })
})
