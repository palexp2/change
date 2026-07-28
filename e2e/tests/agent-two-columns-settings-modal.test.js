// Agent autonome — layout deux colonnes + réglages en modale.
//
// Demande utilisateur : afficher les cartes implantées et les cartes en cours
// d'implémentation en deux colonnes côte à côte (implantées à GAUCHE, en cours
// à DROITE) et déplacer les réglages de l'agent dans une modale ouverte via un
// bouton du header.
//
// Ce test vérifie :
//   1. les deux colonnes existent et sont côte à côte (implantées à gauche) ;
//   2. une carte terminée vit dans la colonne « Implantées », une carte bloquée
//      dans la colonne « En cours d'implémentation » ;
//   3. les réglages ne sont plus rendus en zone de page — ils s'ouvrent dans
//      une modale via le bouton « Réglages », et la modale se ferme (Échap).
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

const DONE_TEXT = `E2E carte implantée deux colonnes ${Date.now()}`
const BLOCKED_TEXT = `E2E carte en cours deux colonnes ${Date.now()}`

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

describe('Agent autonome — deux colonnes + réglages en modale', () => {
  let browser, ctx, page
  let originalEnabled = false
  const seeded = [] // { itemId, taskId }

  before(async () => {
    browser = await chromium.launch()
    // Viewport large (≥ lg) pour que la grille 2 colonnes s'applique.
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Forcer l'agent OFF : les tâches auto-approuvées du seed ne déclenchent
    // aucune exécution Claude.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiFetch(page, 'PUT', '/agent/settings', { enabled: false })

    // Seed 1 : suggestion → tâche liée forcée « done » (colonne Implantées).
    const doneItem = await apiFetch(page, 'POST', '/agent/backlog', { text: DONE_TEXT })
    assert.ok(doneItem.task_id, 'le POST /backlog doit auto-approuver et lier une tâche')
    seeded.push({ itemId: doneItem.id, taskId: doneItem.task_id })
    await apiFetch(page, 'PATCH', `/agent/tasks/${doneItem.task_id}`, {
      status: 'done',
      user_summary: '(seed E2E — implémentation simulée)',
    })

    // Seed 2 : suggestion → tâche liée forcée « blocked » (colonne En cours).
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

  test('les colonnes sont côte à côte, implantées à gauche', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })

    const grid = page.locator('[data-testid="agent-columns"]')
    await grid.waitFor({ timeout: 10000 })

    const colImplantees = page.locator('[data-testid="col-implantees"]')
    const colEnCours = page.locator('[data-testid="col-en-cours"]')
    await colImplantees.waitFor({ timeout: 5000 })
    await colEnCours.waitFor({ timeout: 5000 })

    const boxImplantees = await colImplantees.boundingBox()
    const boxEnCours = await colEnCours.boundingBox()
    assert.ok(boxImplantees && boxEnCours, 'les deux colonnes doivent avoir un bounding box')
    // Côte à côte : même rangée (tops proches) et implantées strictement à gauche.
    assert.ok(boxImplantees.x + boxImplantees.width <= boxEnCours.x + 1,
      `implantées (${boxImplantees.x}+${boxImplantees.width}) doit être à gauche d'en cours (${boxEnCours.x})`)
    assert.ok(Math.abs(boxImplantees.y - boxEnCours.y) < 50,
      'les deux colonnes doivent être sur la même rangée')
  })

  test('chaque carte vit dans la bonne colonne', async () => {
    const doneCard = page.locator(`[data-testid="col-implantees"] [data-testid="suggestion-card"]:has-text("${DONE_TEXT}")`)
    await doneCard.waitFor({ timeout: 5000 })
    assert.equal(await doneCard.count(), 1, 'la carte terminée doit être dans la colonne Implantées')

    const blockedCard = page.locator(`[data-testid="col-en-cours"] [data-testid="suggestion-card"]:has-text("${BLOCKED_TEXT}")`)
    await blockedCard.waitFor({ timeout: 5000 })
    assert.equal(await blockedCard.count(), 1, 'la carte bloquée doit être dans la colonne En cours')

    // Vérification croisée : pas de fuite d'une carte dans l'autre colonne.
    assert.equal(await page.locator(`[data-testid="col-en-cours"] [data-testid="suggestion-card"]:has-text("${DONE_TEXT}")`).count(), 0)
    assert.equal(await page.locator(`[data-testid="col-implantees"] [data-testid="suggestion-card"]:has-text("${BLOCKED_TEXT}")`).count(), 0)
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
