// Agent autonome — colonne « Implantées » seule + réglages en modale.
//
// Remplace l'ancien test « deux colonnes » : la section « En cours
// d'implémentation » a été retirée sur demande de l'utilisateur. Il ne reste que
// l'historique des fiches implantées, sur toute la largeur.
//
// Ce test vérifie :
//   1. la zone « Implantées » est rendue et occupe toute la largeur (plus de
//      grille deux colonnes) ;
//   2. une carte terminée y apparaît, une carte bloquée n'apparaît plus nulle part ;
//   3. les réglages ne sont pas rendus en zone de page — ils s'ouvrent dans une
//      modale via le bouton « Réglages », et la modale se ferme (Échap).
//
// L'agent est forcé OFF pour tout le run → aucune exécution Claude réelle.
// Seed et cleanup passent par l'API ; le toggle est restauré (règle CLAUDE.md).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const DONE_TEXT = `E2E carte implantée colonne unique ${Date.now()}`
const BLOCKED_TEXT = `E2E carte bloquée colonne unique ${Date.now()}`

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

describe('Agent autonome — Implantées seule + réglages en modale', () => {
  let browser, ctx, page
  let originalEnabled = false
  const seeded = [] // { itemId, taskId }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Forcer l'agent OFF : les tâches auto-approuvées du seed ne déclenchent
    // aucune exécution Claude.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed 1 : suggestion → tâche liée forcée « done » (zone Implantées).
    const doneItem = await apiFetch(page, 'POST', '/agent/backlog', { text: DONE_TEXT })
    assert.ok(doneItem.task_id, 'le POST /backlog doit auto-approuver et lier une tâche')
    seeded.push({ itemId: doneItem.id, taskId: doneItem.task_id })
    await apiFetch(page, 'PATCH', `/agent/tasks/${doneItem.task_id}`, {
      status: 'done',
      user_summary: '(seed E2E — implémentation simulée)',
    })

    // Seed 2 : suggestion → tâche liée forcée « blocked » (ne doit plus s'afficher).
    const blockedItem = await apiFetch(page, 'POST', '/agent/backlog', { text: BLOCKED_TEXT })
    assert.ok(blockedItem.task_id, 'le POST /backlog doit auto-approuver et lier une tâche')
    seeded.push({ itemId: blockedItem.id, taskId: blockedItem.task_id })
    await apiFetch(page, 'PATCH', `/agent/tasks/${blockedItem.task_id}`, {
      status: 'blocked',
      agent_result: '(seed E2E — tâche marquée bloquée pour le test)',
    })
  })

  after(async () => {
    // Toujours retirer les seeds et restaurer le toggle, même en cas d'échec.
    for (const { itemId, taskId } of seeded) {
      try { if (taskId && page) await apiFetch(page, 'DELETE', `/agent/tasks/${taskId}`) } catch {}
      try { if (itemId && page) await apiFetch(page, 'DELETE', `/agent/backlog/${itemId}`) } catch {}
    }
    try { if (page) await apiFetch(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('la zone Implantées occupe toute la largeur, plus de colonne « En cours »', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const colImplantees = page.locator('[data-testid="col-implantees"]')
    await colImplantees.waitFor({ timeout: 10000 })

    assert.equal(await page.locator('[data-testid="agent-columns"]').count(), 0,
      'la grille deux colonnes ne doit plus exister')
    assert.equal(await page.locator('[data-testid="col-en-cours"]').count(), 0,
      'la colonne « En cours » ne doit plus exister')
    assert.equal(await page.locator('h2', { hasText: 'En cours d\'implémentation' }).count(), 0,
      'le titre « En cours d\'implémentation » ne doit plus être rendu')

    // Pleine largeur : la zone couvre l'essentiel du conteneur de page.
    const box = await colImplantees.boundingBox()
    const container = await page.locator('h1:has-text("Agent autonome")').boundingBox()
    assert.ok(box && container, 'bounding boxes disponibles')
    assert.ok(box.width > 700, `la zone Implantées doit être large (mesuré ${box.width}px)`)
  })

  test('la carte terminée est dans Implantées, la bloquée n\'apparaît plus', async () => {
    const doneCard = page.locator(`[data-testid="col-implantees"] [data-testid="suggestion-card"]:has-text("${DONE_TEXT}")`)
    await doneCard.waitFor({ timeout: 5000 })
    assert.equal(await doneCard.count(), 1, 'la carte terminée doit être dans la zone Implantées')

    assert.equal(await page.locator(`[data-testid="suggestion-card"]:has-text("${BLOCKED_TEXT}")`).count(), 0,
      'la carte bloquée ne doit plus être affichée sur /agent')
  })

  test('les réglages s\'ouvrent dans une modale via le bouton du header', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    // Plus de zone « Réglages de l'agent » rendue dans la page.
    assert.equal(await page.locator('[role="dialog"]').count(), 0, 'aucune modale ouverte au chargement')
    assert.equal(await page.locator('text=Prompt général').count(), 0,
      'les panneaux de réglages ne doivent plus être rendus dans la page')

    // Le bouton du header ouvre la modale.
    await page.click('[data-testid="agent-settings-button"]')
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ timeout: 5000 })
    assert.ok(await dialog.locator('text=Réglages de l\'agent').count() >= 1, 'la modale porte le titre Réglages de l\'agent')
    assert.ok(await dialog.locator('text=Prompt général').count() >= 1, 'la modale contient le panneau Prompt général')
    assert.ok(await dialog.locator('text=Prompt — exécution (codage)').count() >= 1, 'la modale contient le panneau du prompt d\'exécution')

    // Fermeture via Échap.
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await page.locator('[role="dialog"]').count(), 0, 'la modale se ferme via Échap')
  })
})
