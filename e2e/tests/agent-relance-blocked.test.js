// Agent autonome — bouton « Relancer » sur une tâche bloquée.
//
// Une tâche passe en « bloquée » quand erp-server redémarre pendant son exécution
// (garde-fou anti-boucle de taskRunner.js). Avant, l'UI n'offrait aucun moyen de
// la relancer — il fallait un PATCH API à la main. Ce test vérifie le nouveau
// bouton « Relancer » : il fait repasser la tâche en « approved » (re-queue).
//
// L'agent est forcé OFF pour tout le run → aucun subprocess Claude n'est lancé,
// donc relancer la tâche ne déclenche aucune exécution réelle. Le seed et le
// cleanup passent par l'API (écritures sérialisées côté serveur — pas de course
// avec une éventuelle vraie tâche en cours). Le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const SEED_DESC = `E2E tâche bloquée ${Date.now()}`

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

describe('Agent autonome — relancer une tâche bloquée', () => {
  let browser, ctx, page
  let originalEnabled = false
  let seedId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Sauver la vraie valeur du toggle, puis forcer OFF : ainsi un éventuel
    // passage en « approved » ne lance AUCUNE exécution Claude.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Créer une tâche puis la forcer en « bloquée », via l'API (writes sérialisés).
    const created = await apiFetch(page, 'POST', '/agent/tasks', { description: SEED_DESC })
    seedId = created.id
    await apiFetch(page, 'PATCH', `/agent/tasks/${seedId}`, {
      status: 'blocked',
      agent_result: '(exécution interrompue par un redémarrage serveur — relancer manuellement si besoin)',
    })
  })

  after(async () => {
    // Toujours retirer la tâche semée et restaurer le toggle, même en cas d'échec.
    try { if (seedId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${seedId}`) } catch {}
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('le bouton Relancer fait repasser la tâche en approved', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    // La carte bloquée est visible dans « À traiter » (triée en tête).
    const cardTitle = page.locator(`text=${SEED_DESC}`)
    await cardTitle.waitFor({ timeout: 5000 })

    // Déplier la carte → le bouton « Relancer » doit apparaître (absent avant ce fix).
    await cardTitle.click()
    const relancer = page.locator('button:has-text("Relancer")')
    await relancer.waitFor({ timeout: 5000 })
    assert.equal(await relancer.count(), 1, 'le bouton Relancer doit être présent sur une tâche bloquée')

    // Cliquer Relancer → la tâche repasse en « approved » côté serveur.
    await relancer.click()
    await page.waitForTimeout(600)
    const after = (await apiGet(page, '/agent/tasks')).find(t => t.id === seedId)
    assert.equal(after.status, 'approved', 'Relancer doit faire passer la tâche en approved (re-queue)')

    // L'agent étant OFF, elle reste « approved » sans s'exécuter (pas de bascule in_progress).
    assert.notEqual(after.status, 'in_progress', 'agent OFF → pas d\'exécution déclenchée')
  })
})
