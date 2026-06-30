const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// CustomFieldModal en mode édition : autosave au blur, pas de bouton « Enregistrer ».
// On crée un champ custom data (texte) via l'UI (la nouvelle colonne s'affiche
// automatiquement), on ouvre la modale d'édition via le menu de colonne du
// DataTable, on renomme le champ et on vérifie que la nouvelle valeur est
// persistée sans avoir cliqué sur un bouton de sauvegarde.
describe('CustomFieldModal — autosave en édition', () => {
  let browser, ctx, page, db
  let createdId, columnName
  const originalName = `E2E Autosave ${Date.now()}`
  const renamed = `E2E Renamed ${Date.now()}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    try {
      // Retrouve le champ par son nom courant (renommé si l'autosave a réussi,
      // sinon nom d'origine) pour le supprimer proprement.
      const row = db.prepare('SELECT id, column_name FROM custom_fields WHERE name IN (?, ?)').get(renamed, originalName)
      const id = createdId || row?.id
      const col = columnName || row?.column_name
      if (id) {
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(id)
        if (col) { try { db.exec(`ALTER TABLE projects DROP COLUMN ${col}`) } catch {} }
      }
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('édition : pas de bouton Enregistrer, le renommage autosave au blur', async () => {
    await page.goto(`${URL}/pipeline`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Crée le champ via l'UI — la colonne s'affiche immédiatement dans le tableau.
    const plusBtn = page.locator('button[aria-label="Ajouter un champ"]').first()
    await plusBtn.waitFor({ state: 'visible', timeout: 8000 })
    await plusBtn.click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })
    await page.locator('input[placeholder*="Priorité interne"]').fill(originalName)
    await page.getByRole('button', { name: 'Créer' }).click()

    // Le header de la colonne du champ custom doit apparaître.
    const header = page.locator('div[title^="Clic-droit"]').filter({ hasText: originalName }).first()
    await header.waitFor({ state: 'visible', timeout: 8000 })

    // Récupère l'id en DB pour les vérifications.
    const created = db.prepare('SELECT id, column_name FROM custom_fields WHERE name=? AND deleted_at IS NULL').get(originalName)
    assert.ok(created, 'le champ doit exister en DB')
    createdId = created.id
    columnName = created.column_name

    // Ouvre la modale d'édition via le menu clic-droit de la colonne.
    await header.click({ button: 'right' })
    await page.getByRole('button', { name: 'Modifier le champ' }).click()
    await page.waitForSelector('text=Modifier le champ', { timeout: 5000 })

    // Règle « autosave partout » : aucun bouton « Enregistrer » en édition.
    const saveBtn = page.getByRole('button', { name: 'Enregistrer', exact: true })
    assert.equal(await saveBtn.count(), 0, 'aucun bouton "Enregistrer" ne doit exister en mode édition')
    // Un bouton « Fermer » remplace « Annuler/Enregistrer » dans le footer.
    assert.ok(await page.getByRole('button', { name: 'Fermer' }).count() >= 1, 'le bouton "Fermer" doit exister')

    // Renomme le champ et blur (Tab) — doit déclencher l'autosave.
    const nameInput = page.locator('input[placeholder*="Priorité interne"]')
    await nameInput.fill(renamed)
    await nameInput.press('Tab')

    // Indicateur de sauvegarde visible.
    await page.waitForSelector('text=Enregistré', { timeout: 5000 })

    // Vérifie la persistance côté serveur (direct DB).
    await page.waitForTimeout(300)
    const row = db.prepare('SELECT name FROM custom_fields WHERE id=?').get(createdId)
    assert.equal(row.name, renamed, 'le nom doit avoir été autosauvegardé sans bouton')
  })
})
