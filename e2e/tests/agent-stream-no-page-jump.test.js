// Agent page — the live stream must not yank the whole page.
//
// Regression: TaskStream used bottomRef.scrollIntoView() on every new chunk,
// which scrolled the WHOLE window to the streaming card, making it impossible
// to read other proposals while an execution streamed. The fix scrolls only the
// stream's own inner container.
//
// This test seeds enough proposals to make the page scroll, plus one in_progress
// task whose TaskStream renders below the fold. It scrolls to the top, simulates
// stream chunks arriving (the same `agent:task:stream` window event the realtime
// layer dispatches), and asserts window.scrollY stays at the top.
//
// Agent is forced OFF (no Claude spawned). All seeded tasks are cleaned up.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const fs = require('fs')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const TASKS_FILE = '/home/ec2-user/erp/agent-tasks.json'
const TAG = `e2e-scroll-${Date.now()}`
const RUNNING_ID = `${TAG}-running`

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) } catch { return [] }
}
function writeTasksAtomic(tasks) {
  const tmp = TASKS_FILE + '.e2e.tmp'
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, TASKS_FILE)
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
    return (await fetch('/erp/api' + path, { headers: { Authorization: `Bearer ${tok}` } })).json()
  }, p)
}
async function apiPut(page, p, body) {
  return page.evaluate(async ({ path, body }) => {
    const tok = localStorage.getItem('erp_token')
    return (await fetch('/erp/api' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })).json()
  }, { path: p, body })
}

describe('Agent — le stream ne fait pas sauter la page', () => {
  let browser, ctx, page
  let originalEnabled = false

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1200, height: 500 } })
    page = await ctx.newPage()
    await login(page)

    const s = await apiGet(page, '/agent/settings')
    originalEnabled = !!s.enabled
    await apiPut(page, '/agent/settings', { enabled: false })

    const now = new Date().toISOString()
    const tasks = readTasks()
    // Many pending proposals (triage zone, rendered above) to make the page tall.
    for (let i = 0; i < 10; i++) {
      tasks.push({
        id: `${TAG}-p${i}`, kind: 'proposal', title: `E2E scroll pending ${i}`,
        why: 'remplissage', source: 'A', zone: 'x', risk: 'low', side_effects: 'aucun', effort: 'small',
        description: 'x', status: 'pending', priority: 0, messages: [],
        user_comment: null, agent_result: null, created_at: now, updated_at: now, completed_at: null,
      })
    }
    // One in_progress task — its TaskStream renders in the "En cours" zone, below the fold.
    tasks.push({
      id: RUNNING_ID, kind: 'proposal', title: 'E2E scroll running',
      why: 'x', source: 'A', zone: 'x', risk: 'low', side_effects: 'aucun', effort: 'small',
      description: 'x', status: 'in_progress', priority: 0, messages: [],
      user_comment: null, agent_result: null, created_at: now, updated_at: now, completed_at: null,
    })
    writeTasksAtomic(tasks)
  })

  after(async () => {
    try { writeTasksAtomic(readTasks().filter(t => !String(t.id).startsWith(TAG))) } catch {}
    try { if (page) await apiPut(page, '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('l\'arrivée de chunks de stream ne déplace pas window.scrollY', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=E2E scroll pending 0', { timeout: 10000 })

    // The ERP scrolls via the <main> content area, not the window. Ensure it is
    // scrollable and start at the very top.
    await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 0 })
    await page.waitForTimeout(200)
    const scrollable = await page.evaluate(() => {
      const m = document.querySelector('main')
      return m ? m.scrollHeight > m.clientHeight + 50 : false
    })
    assert.equal(scrollable, true, 'le conteneur <main> doit dépasser le viewport (sinon le test ne prouve rien)')
    const before = await page.evaluate(() => document.querySelector('main').scrollTop)
    assert.equal(before, 0, 'on démarre en haut du conteneur')

    // Simulate a burst of stream chunks for the in_progress task — exactly the
    // event realtime.js dispatches when the server broadcasts agent:task:stream.
    await page.evaluate((id) => {
      for (let i = 0; i < 8; i++) {
        window.dispatchEvent(new CustomEvent('agent:task:stream', {
          detail: { taskId: id, chunk: { kind: 'tool', name: 'Bash', input: `commande de test ${i} ` + 'x'.repeat(80) } },
        }))
      }
    }, RUNNING_ID)
    await page.waitForTimeout(500)

    const after = await page.evaluate(() => document.querySelector('main').scrollTop)
    assert.ok(after <= before + 10, `le contenu ne doit pas sauter vers le stream (scrollTop ${before} → ${after})`)
  })
})
