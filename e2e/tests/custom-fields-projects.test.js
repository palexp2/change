const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Custom fields sur projects : création, valeur inline, suppression (soft) + restore.
describe('Custom fields — projects', () => {
  let browser, ctx, page, token, db
  let createdId
  let projectId

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const p = db.prepare('SELECT id FROM projects WHERE deleted_at IS NULL LIMIT 1').get()
    projectId = p.id
  })

  after(async () => {
    try {
      if (createdId) {
        const cf = db.prepare('SELECT column_name FROM custom_fields WHERE id=?').get(createdId)
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(createdId)
        if (cf?.column_name) {
          try { db.exec(`ALTER TABLE projects DROP COLUMN ${cf.column_name}`) } catch {}
        }
      }
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('créer un champ number avec 2 décimales', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/custom-fields/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'E2E Score', type: 'number', decimals: 2 }),
      })
      return { status: res.status, body: await res.json() }
    }, token)
    assert.equal(r.status, 201)
    assert.equal(r.body.type, 'number')
    assert.equal(r.body.decimals, 2)
    assert.match(r.body.column_name, /^cf_/)
    createdId = r.body.id
    // Colonne créée sur la table
    const cols = db.pragma('table_info(projects)').map(c => c.name)
    assert.ok(cols.includes(r.body.column_name), `colonne ${r.body.column_name} doit exister`)
  })

  test('mettre à jour la valeur via PUT projects', async () => {
    const cf = db.prepare('SELECT column_name FROM custom_fields WHERE id=?').get(createdId)
    const r = await page.evaluate(async ({ tok, pid, col }) => {
      const res = await fetch(`/erp/api/projects/${pid}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [col]: 42.5 }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, pid: projectId, col: cf.column_name })
    assert.equal(r.status, 200)
    assert.equal(r.body[cf.column_name], 42.5)
  })

  test('le champ apparaît dans la liste des projets', async () => {
    const cf = db.prepare('SELECT column_name FROM custom_fields WHERE id=?').get(createdId)
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/projects?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const proj = (r.data || []).find(p => p.id === projectId)
    assert.equal(proj[cf.column_name], 42.5)
  })

  test('soft delete + corbeille + restore', async () => {
    // Soft delete
    const del = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/custom-fields/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      return res.status
    }, { tok: token, id: createdId })
    assert.equal(del, 200)

    // Plus dans la liste active
    const list = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/custom-fields/projects', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    assert.ok(!(list.data || []).some(f => f.id === createdId), 'le champ ne doit plus apparaître dans la liste active')

    // Présent dans la corbeille
    const trash = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/admin/trash', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const trashed = trash.custom_fields?.items || []
    assert.ok(trashed.some(it => it.id === createdId), 'le champ doit apparaître dans la corbeille')

    // Restore
    const restore = await page.evaluate(async ({ tok, id }) => {
      const res = await fetch(`/erp/api/admin/trash/custom_fields/${id}/restore`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` } })
      return res.status
    }, { tok: token, id: createdId })
    assert.equal(restore, 200)

    // Re-actif et la valeur est toujours là (la colonne n'a pas été touchée)
    const cf = db.prepare('SELECT column_name FROM custom_fields WHERE id=? AND deleted_at IS NULL').get(createdId)
    assert.ok(cf, 'le champ doit être restauré (deleted_at NULL)')
    const proj = db.prepare(`SELECT ${cf.column_name} AS v FROM projects WHERE id=?`).get(projectId)
    assert.equal(proj.v, 42.5)
  })

  test('un nouveau champ créé via l\'UI est visible immédiatement dans le tableau', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Compte les bouton + dans les headers — il y en a un
    const plusBtn = page.locator('button[aria-label="Ajouter un champ"]').first()
    await plusBtn.waitFor({ state: 'visible', timeout: 5000 })
    await plusBtn.click()

    // Modale ouverte
    const fieldName = `E2E AutoShow ${Date.now()}`
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })
    await page.locator('input[placeholder*="Priorité interne"]').fill(fieldName)
    await page.locator('button:has-text("Créer")').click()

    // La colonne doit apparaître dans le tableau, sans que l'utilisateur n'ait
    // eu à toucher au panneau "Champs".
    await page.waitForSelector(`text=${fieldName}`, { timeout: 5000 })
    const headers = await page.locator('div.grid > div').allTextContents()
    const found = headers.some(h => h.toUpperCase().includes(fieldName.toUpperCase()))
    assert.ok(found, `Le header "${fieldName}" doit être visible dans le tableau, vu : ${headers.slice(0, 20).join(' | ')}`)

    // Cleanup
    const created = db.prepare('SELECT id, column_name FROM custom_fields WHERE name=?').get(fieldName)
    if (created) {
      db.prepare('DELETE FROM custom_fields WHERE id=?').run(created.id)
      try { db.exec(`ALTER TABLE projects DROP COLUMN ${created.column_name}`) } catch {}
    }
  })

  test('refuse les décimales hors 0-5', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/custom-fields/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad', type: 'number', decimals: 7 }),
      })
      return { status: res.status, body: await res.json() }
    }, token)
    assert.equal(r.status, 400)
  })
})
