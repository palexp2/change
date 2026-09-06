const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const TABLE = 'paies'
const STAMP = Date.now()
const FIELD_NAME = `E2E Vue ${STAMP}`
const VIEW_B = `E2E Vue B ${STAMP}`

// Palier 3 : la visibilité des colonnes appartient à la VUE, pas au champ.
// Un champ créé dans une vue n'apparaît QUE dans celle-là ; ailleurs il existe
// mais reste masqué, à un clic dans le panneau « Colonnes visibles ».
//
// C'est aussi la garantie anti-régression du bug historique de ré-affichage :
// plus rien ne s'ajoute tout seul à une vue, donc un rechargement ne peut plus
// ressusciter une colonne masquée.
describe('Visibilité des champs — portée par vue', () => {
  let browser, ctx, page, token, db
  let viewBId, createdFieldId, createdColumnName, savedPills

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    savedPills = db.prepare('SELECT * FROM table_view_pills WHERE table_name=?').all(TABLE)
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Vue B jetable, avec sa propre liste de colonnes.
    const created = await page.evaluate(async ({ tok, table, label }) => {
      const r = await fetch(`/erp/api/views/${table}/pills`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, visible_columns: ['period_end', 'status'], sort_order: 99 }),
      })
      return { status: r.status, body: await r.json() }
    }, { tok: token, table: TABLE, label: VIEW_B })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    viewBId = created.body.id
  })

  after(async () => {
    try {
      if (viewBId) db.prepare('DELETE FROM table_view_pills WHERE id=?').run(viewBId)
      for (const row of db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name LIKE ?')
        .all(TABLE, `${FIELD_NAME}%`)) {
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id)
        try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${row.column_name}`) } catch {}
      }
      for (const p of savedPills || []) {
        const cols = Object.keys(p).filter(k => k !== 'id')
        db.prepare(`UPDATE table_view_pills SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`)
          .run(...cols.map(c => p[c]), p.id)
      }
    } catch { /* nettoyage best-effort */ }
    db?.close()
    await browser?.close()
  })

  test('un champ créé dans une vue n\'apparaît que dans celle-là', async () => {
    await page.goto(`${URL}/${TABLE}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid^="col-header-"]').first().waitFor({ timeout: 20000 })

    await page.locator('button[aria-label="Ajouter un champ"]').first().click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })
    await page.fill('input[placeholder="ex: Priorité interne"]', FIELD_NAME)
    await page.click('[data-testid="cf-type-text"]')
    await page.click('button[type="submit"]')
    await page.waitForSelector('text=Nouveau champ', { state: 'detached', timeout: 8000 })

    const row = db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name=?').get(TABLE, FIELD_NAME)
    assert.ok(row, 'le champ doit exister côté serveur')
    createdFieldId = row.id
    createdColumnName = row.column_name

    // Visible dans la vue où il vient d'être créé…
    await page.locator(`[data-testid="col-header-${createdColumnName}"]`).waitFor({ timeout: 10000 })

    // …absent de l'autre vue.
    await page.locator(`button:has-text("${VIEW_B}")`).first().click()
    await page.waitForTimeout(1500)
    assert.equal(
      await page.locator(`[data-testid="col-header-${createdColumnName}"]`).count(), 0,
      'le champ ne doit pas s\'inviter dans une vue composée à la main',
    )
  })

  test('le choix de chaque vue survit au rechargement', async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    // On revient sur la vue B (celle sélectionnée avant le rechargement, ou on
    // la re-sélectionne) : la colonne doit toujours en être absente.
    await page.locator(`button:has-text("${VIEW_B}")`).first().click()
    await page.waitForTimeout(1500)
    assert.equal(
      await page.locator(`[data-testid="col-header-${createdColumnName}"]`).count(), 0,
      'un rechargement ne doit pas ressusciter la colonne dans la vue B',
    )
  })
})
