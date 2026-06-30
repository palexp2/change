const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Colonnes visibles par défaut de la table tasks (defaultVisible !== false).
// Base utilisée quand la pill n'a pas de visible_columns explicite.
const DEFAULT_VISIBLE = ['title', 'type', 'status', 'priority', 'due_date', 'company_name', 'contact_name']

// Vérifie que la colonne "Responsable" (assigned_name) du DataTable des tâches
// rend l'utilisateur assigné comme lien cliquable vers sa fiche employé
// (/employees/:id), au même titre que les autres colonnes FK (entreprise, contact).
//
// La tâche est assignée à l'utilisateur courant (qui possède un employee_id) afin
// qu'elle apparaisse sous la pill "Mes tâches" (filtre assigned_name is_me).
describe('Tasks — colonne « Responsable » cliquable vers la fiche employé', () => {
  let browser, ctx, page
  let taskId, taskTitle, employeeId, myName
  let pillId, originalVisibleColumns

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    const setup = await page.evaluate(async (DEFAULT_VISIBLE) => {
      const token = localStorage.getItem('erp_token')
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const me = JSON.parse(atob(token.split('.')[1]))

      // L'utilisateur courant doit être rattaché à un employé existant pour
      // produire le lien /employees/:id.
      const boot = await fetch('/erp/api/bootstrap', { headers }).then(r => r.json())
      const u = boot.tables.users
      const idIdx = u.columns.indexOf('id')
      const empIdx = u.columns.indexOf('employee_id')
      const nameIdx = u.columns.indexOf('name')
      const emp = boot.tables.employees
      const empIds = new Set(emp.rows.map(r => r[emp.columns.indexOf('id')]))
      const myRow = u.rows.find(r => r[idIdx] === me.id)
      if (!myRow || !myRow[empIdx] || !empIds.has(myRow[empIdx])) {
        return { error: "l'utilisateur de test n'a pas d'employee_id valide" }
      }

      // Tâche assignée à l'utilisateur courant.
      const task = await fetch('/erp/api/tasks', {
        method: 'POST', headers,
        body: JSON.stringify({ title: `__taskAssignedLink_${Date.now()}`, assigned_to: me.id }),
      }).then(r => r.json())

      // Rendre la colonne assigned_name visible sur la pill "Mes tâches"
      // (config partagée → capture de l'état initial pour restauration).
      const views = await fetch('/erp/api/views/tasks', { headers }).then(r => r.json())
      const pill = views.pills.find(p => p.label === 'Mes tâches') || views.pills[0]
      const original = Array.isArray(pill.visible_columns) ? pill.visible_columns : []
      const base = original.length ? original : DEFAULT_VISIBLE
      const next = base.includes('assigned_name') ? base : [...base, 'assigned_name']
      await fetch(`/erp/api/views/tasks/pills/${pill.id}`, {
        method: 'PUT', headers, body: JSON.stringify({ visible_columns: next }),
      })

      return {
        taskId: task.id, taskTitle: task.title,
        employeeId: myRow[empIdx], myName: myRow[nameIdx],
        pillId: pill.id, pillLabel: pill.label, originalVisibleColumns: original,
      }
    }, DEFAULT_VISIBLE)

    if (setup.error) throw new Error('Setup E2E impossible : ' + setup.error)
    taskId = setup.taskId
    taskTitle = setup.taskTitle
    employeeId = setup.employeeId
    myName = setup.myName
    pillId = setup.pillId
    originalVisibleColumns = setup.originalVisibleColumns
  })

  after(async () => {
    if (page) {
      await page.evaluate(async ({ taskId, pillId, originalVisibleColumns }) => {
        const token = localStorage.getItem('erp_token')
        const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        // Restaure toujours la config de la pill (même si le test a échoué).
        if (pillId) {
          await fetch(`/erp/api/views/tasks/pills/${pillId}`, {
            method: 'PUT', headers: h, body: JSON.stringify({ visible_columns: originalVisibleColumns || [] }),
          }).catch(() => {})
        }
        if (taskId) await fetch(`/erp/api/tasks/${taskId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }, { taskId, pillId, originalVisibleColumns })
    }
    await browser?.close()
  })

  test('le responsable s\'affiche comme lien vers /employees/:id', async () => {
    await page.goto(`${URL}/tasks`, { waitUntil: 'networkidle' })
    // S'assurer d'être sur la pill "Mes tâches" (filtre is_me → la tâche y est).
    await page.click('button:has-text("Mes tâches")')
    await page.waitForTimeout(400)
    await page.fill('input[placeholder="Rechercher..."]', taskTitle)

    const row = page.locator('div.cursor-pointer', { hasText: taskTitle }).first()
    await row.waitFor({ state: 'attached', timeout: 8000 })

    const link = row.locator(`a[href$="/employees/${employeeId}"]`)
    await link.waitFor({ state: 'attached', timeout: 5000 })
    const href = await link.getAttribute('href')
    assert.ok(href && href.endsWith(`/employees/${employeeId}`), `href employé attendu /employees/${employeeId}, reçu "${href}"`)
    const text = (await link.innerText()).trim()
    assert.equal(text, myName, `le lien doit afficher le nom de l'employé assigné ("${myName}"), reçu "${text}"`)
  })
})
