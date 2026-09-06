const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Tasks <-> Tickets — lien et création depuis le billet', () => {
  let browser, ctx, page
  let createdTicketId, createdTaskId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    await page.evaluate(async ({ ticketId, taskId }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      if (taskId) await fetch(`/erp/api/tasks/${taskId}`, { method: 'DELETE', headers: h })
      if (ticketId) await fetch(`/erp/api/tickets/${ticketId}`, { method: 'DELETE', headers: h })
    }, { ticketId: createdTicketId, taskId: createdTaskId })
    await browser?.close()
  })

  test('API: POST /tasks accepte ticket_id et GET le retourne avec ticket_title', async () => {
    const result = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const ticket = await fetch('/erp/api/tickets', {
        method: 'POST', headers,
        body: JSON.stringify({ title: `__t2t_ticket_${Date.now()}`, status: 'Waiting on us' }),
      }).then(r => r.json())
      const task = await fetch('/erp/api/tasks', {
        method: 'POST', headers,
        body: JSON.stringify({ title: `__t2t_task_${Date.now()}`, ticket_id: ticket.id }),
      }).then(r => r.json())
      const fetched = await fetch(`/erp/api/tasks/${task.id}`, { headers }).then(r => r.json())
      const filtered = await fetch(`/erp/api/tasks?ticket_id=${ticket.id}&limit=all`, { headers }).then(r => r.json())
      return {
        ticketId: ticket.id, taskId: task.id,
        createdTicketId: task.ticket_id,
        createdTitle: task.ticket_title,
        fetchedTicketId: fetched.ticket_id,
        fetchedTitle: fetched.ticket_title,
        filteredCount: filtered.data.length,
        filteredFirstTaskId: filtered.data[0]?.id,
      }
    })
    createdTicketId = result.ticketId
    createdTaskId = result.taskId
    assert.strictEqual(result.createdTicketId, createdTicketId, 'POST doit retourner ticket_id')
    assert.ok(result.createdTitle, 'POST doit retourner ticket_title')
    assert.strictEqual(result.fetchedTicketId, createdTicketId)
    assert.strictEqual(result.fetchedTitle, result.createdTitle)
    assert.strictEqual(result.filteredCount, 1, 'filtre ?ticket_id= doit retourner 1 tâche')
    assert.strictEqual(result.filteredFirstTaskId, createdTaskId)
  })

  test('UI: ticket detail affiche la section Tâches liées avec la tâche', async () => {
    await page.goto(`${URL}/tickets/${createdTicketId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=Tâches liées', { timeout: 5000 })
    const row = page.locator('[data-testid="ticket-task-row"]').first()
    await row.waitFor({ state: 'visible', timeout: 5000 })
    const text = await row.textContent()
    assert.ok(text.includes('__t2t_task_'), `tâche listée, got: ${text}`)
  })

  test('UI: bouton "Nouvelle tâche" sur le billet crée une tâche pré-liée', async () => {
    await page.goto(`${URL}/tickets/${createdTicketId}`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="ticket-new-task"]')
    await page.waitForSelector('label:has-text("Titre *")', { timeout: 5000 })
    const title = `__t2t_inline_${Date.now()}`
    await page.fill('input[placeholder="Titre de la tâche"]', title)
    await page.click('button:has-text("Enregistrer")')
    await page.waitForSelector(`text=${title}`, { timeout: 5000 })
    // Vérifier côté API que la tâche est bien liée au billet
    const checkResult = await page.evaluate(async ({ ticketId, title }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      const list = await fetch(`/erp/api/tasks?ticket_id=${ticketId}&limit=all`, { headers: h }).then(r => r.json())
      const found = list.data.find(t => t.title === title)
      return { found: !!found, ticketId: found?.ticket_id, taskId: found?.id }
    }, { ticketId: createdTicketId, title })
    assert.ok(checkResult.found, 'la tâche créée doit être trouvable via le filtre ticket_id')
    assert.strictEqual(checkResult.ticketId, createdTicketId, 'ticket_id de la tâche doit correspondre')
    // Cleanup la tâche inline créée
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    }, checkResult.taskId)
  })
})
