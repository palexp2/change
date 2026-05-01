const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { randomUUID } = require('crypto')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le nouveau champ Vendeur (single-select) sur la fiche projet :
// (1) un employé actif salesperson apparaît dans le picker,
// (2) cocher "Vendeur Orisha" sur une company la rend disponible aussi,
// (3) la sélection persiste via PUT /api/projects/:id.
describe('ProjectDetail — champ Vendeur (employés salesperson + companies vendeur Orisha)', () => {
  let browser, ctx, page, token, db
  let projectId, employeeId, companyId
  let originalEmployeeFlag, originalCompanyFlag

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Trouve un employé actif et marque-le salesperson (snapshot état avant)
    const emp = db.prepare(`SELECT id, is_salesperson FROM employees WHERE active=1 LIMIT 1`).get()
    if (!emp) throw new Error('Aucun employé actif — impossible de tester')
    employeeId = emp.id
    originalEmployeeFlag = emp.is_salesperson || 0
    db.prepare('UPDATE employees SET is_salesperson=1 WHERE id=?').run(employeeId)

    // Choisit une company existante et marque-la vendeur Orisha
    const co = db.prepare(`SELECT id, is_vendeur_orisha FROM companies WHERE deleted_at IS NULL LIMIT 1`).get()
    if (!co) throw new Error('Aucune company — impossible de tester')
    companyId = co.id
    originalCompanyFlag = co.is_vendeur_orisha || 0
    db.prepare('UPDATE companies SET is_vendeur_orisha=1 WHERE id=?').run(companyId)

    // Crée un projet de test
    projectId = randomUUID()
    db.prepare(`
      INSERT INTO projects (id, name, status) VALUES (?, ?, ?)
    `).run(projectId, `E2E Vendeur ${Date.now()}`, 'Ouvert')

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    try { if (projectId) db.prepare('DELETE FROM projects WHERE id=?').run(projectId) } catch {}
    try { if (employeeId) db.prepare('UPDATE employees SET is_salesperson=? WHERE id=?').run(originalEmployeeFlag, employeeId) } catch {}
    try { if (companyId) db.prepare('UPDATE companies SET is_vendeur_orisha=? WHERE id=?').run(originalCompanyFlag, companyId) } catch {}
    db?.close()
    await browser?.close()
  })

  test('options inclut employé salesperson + company vendeur Orisha', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/projects/vendeur-options', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const refs = (r.data || []).map(o => o.ref)
    assert.ok(refs.includes(`employee:${employeeId}`), `Devrait inclure employee:${employeeId}, vu : ${refs.slice(0,5).join(', ')}…`)
    assert.ok(refs.includes(`company:${companyId}`), `Devrait inclure company:${companyId}, vu : ${refs.slice(0,5).join(', ')}…`)
  })

  test('sélection via UI persiste vendeur_ref', async () => {
    await page.goto(`${URL}/projects/${projectId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    // Le picker affiche "— Aucun —" par défaut. On clique pour ouvrir.
    const trigger = page.locator('button:has-text("— Aucun —")').first()
    await trigger.waitFor({ state: 'visible', timeout: 5000 })
    await trigger.click()
    // On clique le 1er résultat qui correspond à l'employé
    const empRow = page.locator(`button:has-text("Employé")`).first()
    await empRow.waitFor({ state: 'visible', timeout: 5000 })
    await empRow.click()

    // Attend que le PUT soit complété — on poll l'API jusqu'à voir vendeur_ref mis à jour.
    await page.waitForFunction(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projects/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      const p = await r.json()
      return p.vendeur_ref && p.vendeur_ref.startsWith('employee:')
    }, { tok: token, id: projectId }, { timeout: 5000 })

    const fetched = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projects/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: projectId })
    assert.equal(fetched.vendeur_ref, `employee:${employeeId}`)
  })

  test('liste projets retourne vendeur_label résolu + vendeur (AT) brut', async () => {
    // Set un Vendeur AT brut sur le projet pour vérifier qu'il sort dans la liste.
    db.prepare("UPDATE projects SET vendeur=? WHERE id=?").run('legacy-AT-vendeur', projectId)
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/projects?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const row = (r.data || []).find(p => p.id === projectId)
    assert.ok(row, 'Le projet de test doit être dans la liste')
    assert.ok(row.vendeur_label && row.vendeur_label.length > 0, `vendeur_label doit être résolu, vu : "${row.vendeur_label}"`)
    assert.equal(row.vendeur, 'legacy-AT-vendeur')
  })

  test('décocher Vendeur Orisha retire la company des options', async () => {
    db.prepare('UPDATE companies SET is_vendeur_orisha=0 WHERE id=?').run(companyId)
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/projects/vendeur-options', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const refs = (r.data || []).map(o => o.ref)
    assert.ok(!refs.includes(`company:${companyId}`), `Ne devrait PAS inclure company:${companyId} après décochage`)
  })
})
