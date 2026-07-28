// Agent autonome — UI smoke test (modèle « suggestions → correctifs »).
//
// Vérifie la page /agent rebâtie :
//   1. Page renders: header + global ON/OFF toggle.
//   2. Toggle flips and persists (settings saved/restored — CLAUDE.md config rule).
//   3. Une sous-tâche seedée (kind proposal, sans backlog_id) rend dans la zone
//      « Sous-tâches de l'agent » avec son badge de risque, supporte le fil de
//      discussion (agent OFF → message stocké sans spawn) et peut être rejetée.
//   4. Le formulaire « Nouvelle suggestion » a été RETIRÉ de la page — la création
//      passe par la bulle « Modifier le système » (FeedbackFab). Le test vérifie
//      l'absence du formulaire, crée une fiche via la bulle, puis la supprime.
//
// The agent is forced OFF for the whole run so NO execution/conversation Claude is
// spawned (la suggestion est auto-approuvée en tâche, mais le runner est en pause).
// All created state is cleaned up in after(), and the user's real toggle value is
// restored.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Same file the server's taskRunner reads/writes.
const TASKS_FILE = '/home/ec2-user/erp/agent-tasks.json'
const SEED_ID = `e2e-prop-${Date.now()}`

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) } catch { return [] }
}
function writeTasksAtomic(tasks) {
  const tmp = TASKS_FILE + '.e2e.tmp'
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, path.resolve(TASKS_FILE))
}

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiGet(page, p) {
  return page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}
async function apiPut(page, p, body) {
  return page.evaluate(async ({ path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
    return r.json()
  }, { path: p, body })
}
async function apiDelete(page, p) {
  return page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, p)
}

describe('Agent autonome — UI', () => {
  let browser, ctx, page
  let originalEnabled = false
  let createdBacklogId = null
  let createdTaskId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Capture the user's real toggle value, then force OFF for the test.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiPut(page, '/agent/settings', { enabled: false })

    // Seed a high-risk sub-task directly into the live task file (agent is OFF,
    // so nothing races us). Cleaned up in after().
    const now = new Date().toISOString()
    const tasks = readTasks()
    tasks.push({
      id: SEED_ID,
      kind: 'proposal',
      title: `E2E proposition ${SEED_ID}`,
      why: 'Vérifie le rendu de la carte proposition dans le test E2E.',
      source: 'C',
      zone: 'client/src/pages/E2E.jsx',
      risk: 'high',
      side_effects: 'aucun',
      effort: 'small',
      description: 'E2E proposition',
      status: 'pending',
      priority: 0,
      messages: [],
      user_comment: null,
      agent_result: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    })
    writeTasksAtomic(tasks)
  })

  after(async () => {
    // Always remove the seeded task + created suggestion and restore the user's
    // real toggle value, even if the test failed.
    try { writeTasksAtomic(readTasks().filter(t => t.id !== SEED_ID)) } catch {}
    try { if (createdTaskId && page) await apiDelete(page, `/agent/tasks/${createdTaskId}`) } catch {}
    try { if (createdBacklogId && page) await apiDelete(page, `/agent/backlog/${createdBacklogId}`) } catch {}
    try { if (page) await apiPut(page, '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('page + toggle + suggestion + sous-tâche', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })

    // 1. Header + toggle present.
    await page.waitForSelector('text=Agent autonome', { timeout: 10000 })
    const toggle = page.locator('button[title^="Frein"]')
    await assert.equal(await toggle.count(), 1, 'le toggle ON/OFF doit être présent')
    assert.match(await toggle.innerText(), /OFF/, 'toggle doit afficher OFF (forcé off au setup)')

    // 2. Toggle flips ON then back OFF, persisting through the API.
    await toggle.click()
    await page.waitForTimeout(400)
    let s = await apiGet(page, '/agent/settings')
    assert.equal(s.enabled, true, 'cliquer le toggle doit activer l\'agent')
    await toggle.click()
    await page.waitForTimeout(400)
    s = await apiGet(page, '/agent/settings')
    assert.equal(s.enabled, false, 'recliquer doit désactiver l\'agent')

    // 3. Le formulaire « Nouvelle suggestion » a été retiré de la page — la
    //    création passe désormais uniquement par la bulle « Modifier le système ».
    // (Pas d'assertion sur le texte « Nouvelle suggestion » : des fiches de
    // suggestion existantes peuvent contenir cette expression dans leur contenu.)
    assert.equal(await page.locator('[data-testid="new-suggestion-text"]').count(), 0, 'le champ du formulaire Nouvelle suggestion ne doit plus exister sur /agent')
    assert.equal(await page.locator('[data-testid="new-suggestion-submit"]').count(), 0, 'le bouton du formulaire Nouvelle suggestion ne doit plus exister sur /agent')

    // Création via la bulle (FeedbackFab, montée dans Layout donc visible ici).
    const ideaText = `E2E suggestion ${Date.now()}`
    await page.click('[data-testid="feedback-fab"]') // ouvre directement le formulaire (demande générale)
    await page.waitForSelector('[data-testid="feedback-fab-text"]', { timeout: 5000 })
    await page.fill('[data-testid="feedback-fab-text"]', ideaText)
    await page.click('[data-testid="feedback-fab-submit"]')
    await page.waitForSelector('[data-testid="feedback-approved"]', { timeout: 10000 })
    await page.click('button:has-text("Fermer")')

    // La fiche doit apparaître sur /agent (rechargement pour rafraîchir la liste).
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector(`text=${ideaText}`, { timeout: 10000 })
    const backlog = await apiGet(page, '/agent/backlog')
    const item = backlog.find(i => i.text === ideaText)
    assert.ok(item, 'la suggestion doit exister côté API')
    createdBacklogId = item.id
    createdTaskId = item.task_id || null
    assert.equal(item.context, '/agent', 'le contexte doit être la page agent')
    assert.ok(item.author, 'l\'auteur doit être enregistré')
    assert.ok(item.task_id, 'la suggestion doit être auto-approuvée en tâche liée')

    // Suppression de la fiche via sa corbeille → disparaît (supprime aussi la tâche liée).
    const card = page.locator('[data-testid="suggestion-card"]', { hasText: ideaText })
    await card.locator('button[title="Supprimer la suggestion"]').click()
    await page.waitForTimeout(500)
    assert.equal(await page.locator(`text=${ideaText}`).count(), 0, 'la fiche doit disparaître après suppression')
    const backlogAfter = await apiGet(page, '/agent/backlog')
    assert.ok(!backlogAfter.find(i => i.id === item.id), 'la suggestion doit être supprimée côté API')
    createdBacklogId = null
    createdTaskId = null

    // 4. Seeded sub-task: card visible with high-risk badge in « Sous-tâches ».
    const cardTitle = page.locator(`text=E2E proposition ${SEED_ID}`)
    await cardTitle.waitFor({ timeout: 5000 })
    await assert.equal(await page.locator('text=Risque élevé').count() >= 1, true, 'badge risque élevé attendu')

    // Expand the card → conversation input + reject button appear.
    await cardTitle.click()
    const discuss = page.locator('textarea[placeholder^="Discuter"]')
    await discuss.waitFor({ timeout: 5000 })
    await assert.equal(await page.locator('button:has-text("Approuver & coder")').count(), 1, 'bouton Approuver & coder attendu')

    // Send a discussion message (agent OFF → stored, no Claude reply spawned).
    const msg = `E2E question ${Date.now()}`
    await discuss.fill(msg)
    await page.click('button[title="Envoyer (⌘+Entrée)"]')
    await page.waitForSelector(`text=${msg}`, { timeout: 5000 })
    const tasksAfter = await apiGet(page, '/agent/tasks')
    const seeded = tasksAfter.find(t => t.id === SEED_ID)
    assert.ok(seeded && (seeded.messages || []).some(m => m.role === 'user' && m.text === msg), 'le message doit être persisté sur la proposition')
    assert.equal(seeded.status, 'in_discussion', 'la proposition passe en discussion après un message')

    // Reject → leaves the sub-tasks zone's triage state.
    await page.click('button:has-text("Rejeter")')
    await page.waitForTimeout(500)
    const rejected = (await apiGet(page, '/agent/tasks')).find(t => t.id === SEED_ID)
    assert.equal(rejected.status, 'rejected', 'la proposition doit être rejetée')
    assert.equal(await page.locator('button:has-text("Approuver & coder")').count(), 0, 'plus de bouton Approuver après rejet')
  })
})
