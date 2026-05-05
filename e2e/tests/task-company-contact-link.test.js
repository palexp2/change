const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la fiche détaillée d'une tâche (modale "Modifier la tâche")
// affiche l'entreprise et le contact comme liens cliquables vers leurs fiches.
describe('Task detail — entreprise et contact cliquables', () => {
  let browser, ctx, page
  let companyId, contactId, taskId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Setup : 1 entreprise, 1 contact, 1 tâche liant les deux
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const company = await fetch('/erp/api/companies', {
        method: 'POST', headers,
        body: JSON.stringify({ name: `__taskLinkCo_${Date.now()}` }),
      }).then(r => r.json())
      const contact = await fetch('/erp/api/contacts', {
        method: 'POST', headers,
        body: JSON.stringify({ first_name: 'Test', last_name: `__taskLinkCt_${Date.now()}` }),
      }).then(r => r.json())
      const task = await fetch('/erp/api/tasks', {
        method: 'POST', headers,
        body: JSON.stringify({
          title: `__taskLinkTask_${Date.now()}`,
          company_id: company.id,
          contact_id: contact.id,
        }),
      }).then(r => r.json())
      return { companyId: company.id, contactId: contact.id, taskId: task.id }
    })
    companyId = setup.companyId
    contactId = setup.contactId
    taskId = setup.taskId
  })

  after(async () => {
    await page.evaluate(async ({ taskId, contactId, companyId }) => {
      const token = localStorage.getItem('erp_token')
      const h = { Authorization: `Bearer ${token}` }
      if (taskId) await fetch(`/erp/api/tasks/${taskId}`, { method: 'DELETE', headers: h }).catch(() => {})
      if (contactId) await fetch(`/erp/api/contacts/${contactId}`, { method: 'DELETE', headers: h }).catch(() => {})
      if (companyId) await fetch(`/erp/api/companies/${companyId}`, { method: 'DELETE', headers: h }).catch(() => {})
    }, { taskId, contactId, companyId })
    await browser?.close()
  })

  async function openTaskModal() {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    // Bascule sur la vue "Toutes les tâches" (le pill par défaut "Mes tâches"
    // filtre par assigned_to=user courant et masquerait la tâche de test).
    await page.click('button:has-text("Toutes les tâches")')
    await page.waitForTimeout(300)
    // Filtrer la liste pour rendre la tâche visible (DataTable virtualise)
    await page.fill('input[placeholder="Rechercher..."]', '__taskLinkTask_')
    // La row DataTable est un div virtualisé (pas un <tr>) — attendre l'attachement DOM
    const row = page.locator('div.cursor-pointer', { hasText: '__taskLinkTask_' }).first()
    await row.waitFor({ state: 'attached', timeout: 8000 })
    await row.click({ force: true })
    await page.waitForSelector('label:has-text("Titre *")', { timeout: 5000 })
  }

  test('clic sur le nom de l\'entreprise → ouvre la fiche entreprise', async () => {
    await openTaskModal()

    const companyField = page.locator('[data-testid="linked-record-field-task_company_id"]')
    await companyField.waitFor({ timeout: 3000 })
    const link = companyField.locator('[data-testid="linked-record-link"]')
    await link.waitFor({ timeout: 3000 })
    const href = await link.getAttribute('href')
    assert.ok(href && href.endsWith(`/companies/${companyId}`), `href entreprise attendu /companies/${companyId}, reçu "${href}"`)
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/companies/${companyId}`), { timeout: 5000 })
  })

  test('clic sur le nom du contact → ouvre la fiche contact', async () => {
    await openTaskModal()

    const contactField = page.locator('[data-testid="linked-record-field-task_contact_id"]')
    await contactField.waitFor({ timeout: 3000 })
    const link = contactField.locator('[data-testid="linked-record-link"]')
    await link.waitFor({ timeout: 3000 })
    const href = await link.getAttribute('href')
    assert.ok(href && href.endsWith(`/contacts/${contactId}`), `href contact attendu /contacts/${contactId}, reçu "${href}"`)
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/contacts/${contactId}`), { timeout: 5000 })
  })
})
