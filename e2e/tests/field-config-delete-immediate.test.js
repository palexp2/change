const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Supprimer un champ depuis la page de configuration des champs doit le faire
// disparaître TOUT DE SUITE, sans recharger la page.
//
// Deux chemins d'accès, parce qu'ils ne construisent pas la liste pareil :
//   • URL directe (/projects/fields → /champs/projects) : la liste part des
//     colonnes statiques de tableDefs.js ;
//   • bouton « Configurer les champs » d'un DataTable : la liste part des
//     colonnes passées en state de navigation — état FIGÉ dans l'historique.
//     Une colonne `cf_*` supprimée y restait, et comme le state survit à un F5
//     la ligne ne s'en allait plus du tout.
//
// Champs JETABLES créés par le test, purgés en after() (soft delete + ligne
// custom_fields + colonne physique). Aucun champ ni record réel n'est touché.
describe('Config des champs — la suppression se voit immédiatement', () => {
  let browser, ctx, page, token, db
  const createdColumns = []

  async function createField(name) {
    const f = await page.evaluate(async ({ tok, name }) => {
      const res = await fetch('/erp/api/custom-fields/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'text' }),
      })
      return { status: res.status, body: await res.json() }
    }, { tok: token, name })
    assert.equal(f.status, 201, JSON.stringify(f.body))
    createdColumns.push(f.body.column_name)
    return f.body
  }

  // Attend le chargement complet du tableau : les métadonnées Airtable arrivent
  // après les champs perso, et c'est ce second chargement qui décide du sort des
  // colonnes non natives.
  async function waitForFieldsTable(column) {
    await page.locator(`[data-testid="fieldcfg-row-${column}"]`).waitFor({ state: 'visible', timeout: 90000 })
    await page.locator('text=/mappé.? depuis Airtable/').waitFor({ timeout: 90000 })
    await page.waitForTimeout(1500)
  }

  async function deleteFieldFromRow(column) {
    const trash = page.locator(`[data-testid="fieldcfg-delete-${column}"]`)
    await trash.scrollIntoViewIfNeeded()
    await trash.click()
    await page.locator('text=Restaurable depuis la corbeille').waitFor({ timeout: 10000 })
    await page.locator('button:has-text("Supprimer")').last().click()
  }

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    for (const col of createdColumns) {
      try { db.prepare('DELETE FROM custom_fields WHERE erp_table=? AND column_name=?').run('projects', col) } catch { /* déjà parti */ }
      try { db.prepare('DELETE FROM airtable_field_mappings WHERE erp_table=? AND column_name=?').run('projects', col) } catch { /* jamais mappé */ }
      try { db.exec(`ALTER TABLE projects DROP COLUMN ${col}`) } catch { /* colonne virtuelle */ }
    }
    db?.close()
    await browser?.close()
  })

  test('URL directe /projects/fields : la ligne part sans rechargement', async () => {
    const field = await createField('ZZ E2E Direct ' + Date.now())
    const row = page.locator(`[data-testid="fieldcfg-row-${field.column_name}"]`)

    await page.goto(URL + '/projects/fields', { waitUntil: 'domcontentloaded' })
    await waitForFieldsTable(field.column_name)
    const before = await page.locator('[data-testid^="fieldcfg-row-"]').count()

    await deleteFieldFromRow(field.column_name)
    await row.waitFor({ state: 'detached', timeout: 5000 })

    assert.equal(await row.count(), 0, 'la ligne devait disparaître sans recharger la page')
    assert.equal(
      await page.locator('[data-testid="fieldcfg-search"]').count(), 1,
      'la page ne doit pas avoir été rechargée pendant le test'
    )
    assert.equal(await page.locator('[data-testid^="fieldcfg-row-"]').count(), before - 1)
  })

  test('Depuis « Configurer les champs » : la ligne part sans rechargement, et ne revient pas au F5', async () => {
    const field = await createField('ZZ E2E NavState ' + Date.now())
    const row = page.locator(`[data-testid="fieldcfg-row-${field.column_name}"]`)

    await page.goto(URL + '/pipeline', { waitUntil: 'domcontentloaded' })
    const openBtn = page.locator('button:has-text("Configurer les champs")').first()
    await openBtn.waitFor({ state: 'visible', timeout: 60000 })
    await openBtn.click()
    await page.waitForURL(/\/champs\/projects/, { timeout: 20000 })
    await waitForFieldsTable(field.column_name)

    await deleteFieldFromRow(field.column_name)
    await row.waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await row.count(), 0, 'la ligne devait disparaître sans recharger la page')

    // Le state de navigation est figé dans l'historique : sans le correctif la
    // ligne revenait à chaque rechargement.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('text=/mappé.? depuis Airtable/').waitFor({ timeout: 90000 })
    await page.waitForTimeout(1500)
    assert.equal(await row.count(), 0, 'la ligne ne devait pas réapparaître après un rechargement')
  })
})
