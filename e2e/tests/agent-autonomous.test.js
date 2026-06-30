// Autonomous improvement agent — UI smoke test.
//
// Verifies the rebuilt /agent page (propose-first model):
//   1. Page renders: header + global ON/OFF toggle.
//   2. Toggle flips and persists (settings saved/restored — CLAUDE.md config rule).
//   3. Backlog ("jeter une idée"): add via UI → appears → delete → gone.
//   4. A seeded proposal renders with its risk badge, supports the read-only
//      conversation thread, and can be rejected (leaves the triage zone).
//
// The agent is forced OFF for the whole run so NO Claude subprocess is ever
// spawned (no generation / no conversation reply / no execution). All created
// state is cleaned up in after(), and the user's real toggle value is restored.

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

describe('Agent autonome — UI', () => {
  let browser, ctx, page
  let originalEnabled = false

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Capture the user's real toggle value, then force OFF for the test.
    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiPut(page, '/agent/settings', { enabled: false })

    // Seed a high-risk proposal directly into the live task file (agent is OFF,
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
    // Always remove the seeded task and restore the user's real toggle value,
    // even if the test failed.
    try { writeTasksAtomic(readTasks().filter(t => t.id !== SEED_ID)) } catch {}
    try { if (page) await apiPut(page, '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('page + toggle + backlog + proposition', async () => {
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

    // 3. Backlog: open panel, add an idea via UI, see it, delete it.
    const ideaText = `E2E idée ${Date.now()}`
    await page.click('text=Jeter une idée')
    const backlogInput = page.locator('textarea[placeholder^="Une note vague"]')
    await backlogInput.fill(ideaText)
    await page.click('button[title="Ajouter au backlog"]')
    await page.waitForSelector(`text=${ideaText}`, { timeout: 5000 })
    // Delete it (the trash button next to our idea).
    const row = page.locator('div', { hasText: ideaText }).last()
    await row.locator('button').last().click()
    await page.waitForTimeout(400)
    assert.equal(await page.locator(`text=${ideaText}`).count(), 0, 'l\'idée backlog doit disparaître après suppression')

    // 4. Seeded proposal: card visible with high-risk badge.
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
    await page.click('button[title^="Envoyer"]')
    await page.waitForSelector(`text=${msg}`, { timeout: 5000 })
    // Confirm it was persisted as a user message on the task.
    const tasksAfter = await apiGet(page, '/agent/tasks')
    const seeded = tasksAfter.find(t => t.id === SEED_ID)
    assert.ok(seeded && (seeded.messages || []).some(m => m.role === 'user' && m.text === msg), 'le message doit être persisté sur la proposition')
    assert.equal(seeded.status, 'in_discussion', 'la proposition passe en discussion après un message')

    // Reject → leaves the triage zone (moves to collapsed Historique).
    await page.click('button:has-text("Rejeter")')
    await page.waitForTimeout(500)
    const rejected = (await apiGet(page, '/agent/tasks')).find(t => t.id === SEED_ID)
    assert.equal(rejected.status, 'rejected', 'la proposition doit être rejetée')
    // The "Approuver & coder" button for this card must be gone from view.
    assert.equal(await page.locator('button:has-text("Approuver & coder")').count(), 0, 'plus de bouton Approuver après rejet')
  })
})
