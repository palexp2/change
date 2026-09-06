// Agent autonome — le bloc « Ce qui a changé » d'une implémentation terminée
// ne doit apparaître QUE lorsque la carte est dépliée, pas repliée.
//
// Signalement utilisateur : sur les cartes terminées, le compte-rendu non
// technique était affiché en permanence (même carte repliée). Fix : le bloc
// user_summary est déplacé dans la section `expanded` (SuggestionCard et
// ProposalCard).
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

const SEED_DESC = `E2E résumé visible seulement déplié ${Date.now()}`
const SEED_SUMMARY = 'Résumé de test : visible uniquement carte dépliée.'

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

describe('Agent autonome — « Ce qui a changé » visible uniquement carte dépliée', () => {
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

    // Seed : POST /backlog auto-approuve → item + tâche liée « approved ».
    const created = await apiFetch(page, 'POST', '/agent/backlog', { text: SEED_DESC })
    seedId = created.id
    seedTaskId = created.task_id || null
    assert.ok(seedTaskId, 'le POST /backlog doit créer une tâche liée')

    // Simule une implémentation complétée (pattern des seeds E2E existants).
    const now = new Date().toISOString()
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedTaskId}`, {
      status: 'done',
      user_summary: SEED_SUMMARY,
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

  test('carte repliée : pas de « Ce qui a changé » ; carte dépliée : présent', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const card = page.locator('[data-testid="suggestion-card"]', { hasText: SEED_DESC })
    await card.waitFor({ timeout: 5000 })

    // Repliée : ni le libellé ni le résumé ne doivent apparaître.
    assert.equal(await card.locator('[data-testid="suggestion-user-summary"]').count(), 0,
      'le bloc « Ce qui a changé » ne doit pas apparaître carte repliée')
    const collapsedTxt = (await card.innerText()).replace(/\s+/g, ' ')
    assert.ok(!collapsedTxt.includes(SEED_SUMMARY),
      `le résumé ne doit pas être visible carte repliée (reçu: « ${collapsedTxt.slice(0, 300)} »)`)

    // Dépliée : le bloc doit apparaître avec le résumé.
    await card.locator('.cursor-pointer').first().click()
    await card.locator('[data-testid="suggestion-user-summary"]').waitFor({ timeout: 5000 })
    const expandedTxt = (await card.innerText()).replace(/\s+/g, ' ')
    // Libellé rendu en MAJUSCULES via la classe CSS `uppercase` → comparaison insensible à la casse.
    assert.ok(/ce qui a changé/i.test(expandedTxt) && expandedTxt.includes(SEED_SUMMARY),
      `le résumé doit être visible carte dépliée (reçu: « ${expandedTxt.slice(0, 300)} »)`)

    // Re-replie : le bloc disparaît à nouveau.
    await card.locator('.cursor-pointer').first().click()
    await page.waitForTimeout(300)
    assert.equal(await card.locator('[data-testid="suggestion-user-summary"]').count(), 0,
      'le bloc doit disparaître quand on replie la carte')
  })
})
