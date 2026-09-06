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
const FIELD_NAME = `E2E Menu ${STAMP}`

// Palier 2 de l'unification des champs : le menu d'en-tête devient le lieu
// unique et IDENTIQUE pour tout champ — natif comme personnalisé.
//   • chevron visible au survol, ouvert au clic GAUCHE ;
//   • mêmes entrées partout : Modifier · Dupliquer · Insérer à gauche/droite ·
//     Masquer · Supprimer ;
//   • renommage EN LIGNE au double-clic sur l'en-tête (autosave) ;
//   • suppression sans boîte de dialogue quand le champ n'a aucune dépendance,
//     avec « Annuler » pendant 10 s.
//
// Aucun enregistrement réel n'est touché : le test crée SON champ jetable et le
// supprime en after() (ligne + colonne physique), et restaure les pills de vue.
describe('Menu d\'en-tête de champ — unifié natif / personnalisé', () => {
  let browser, ctx, page, token, db
  let createdFieldId, createdColumnName, dupColumnName
  let savedPills

  const api = (path, opts = {}) => page.evaluate(async ({ path, opts, tok }) => {
    const r = await fetch(`/erp/api${path}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts, tok: token })

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
  })

  after(async () => {
    try {
      for (const row of db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name LIKE ?')
        .all(TABLE, `E2E Menu ${STAMP}%`)) {
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id)
        try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${row.column_name}`) } catch {}
      }
      // Personnalisations natives éventuellement laissées par le test.
      db.prepare("DELETE FROM custom_fields WHERE erp_table=? AND kind='native'").run(TABLE)
      for (const p of savedPills || []) {
        const cols = Object.keys(p).filter(k => k !== 'id')
        db.prepare(`UPDATE table_view_pills SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`)
          .run(...cols.map(c => p[c]), p.id)
      }
    } catch { /* nettoyage best-effort */ }
    db?.close()
    await browser?.close()
  })

  test('le chevron ouvre le même menu sur un champ natif et sur un champ perso', async () => {
    await page.goto(`${URL}/${TABLE}`, { waitUntil: 'networkidle' })
    const header = page.locator('[data-testid^="col-header-"]').first()
    await header.waitFor({ timeout: 20000 })
    const colId = (await header.getAttribute('data-testid')).replace('col-header-', '')

    await header.hover()
    const chevron = page.locator(`[data-testid="col-menu-btn-${colId}"]`)
    assert.equal(await chevron.count(), 1, 'un chevron doit exister dans l\'en-tête')
    await chevron.click()

    for (const entry of ['colmenu-duplicate-field', 'colmenu-insert-left', 'colmenu-insert-right', 'colmenu-delete-field']) {
      assert.equal(await page.locator(`[data-testid="${entry}"]`).count(), 1, `entrée ${entry} attendue sur un champ natif`)
    }
    const editable = await page.locator('[data-testid="colmenu-edit-native-field"], [data-testid="colmenu-edit-custom-field"]').count()
    assert.equal(editable, 1, 'une entrée « Modifier le champ » attendue')
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
  })

  test('renommage en ligne au double-clic, sans modale ni bouton Enregistrer', async () => {
    // Création par le « + » de l'en-tête : c'est le flux réel, et il place la
    // colonne dans la vue courante (l'auto-affichage ne joue que sur une
    // création vécue par la session — après un rechargement, un champ déjà
    // existant reste masqué tant que la vue ne le liste pas).
    await page.locator('button[aria-label="Ajouter un champ"]').first().click()
    await page.waitForSelector('text=Nouveau champ', { timeout: 5000 })
    await page.fill('input[placeholder="ex: Priorité interne"]', FIELD_NAME)
    await page.click('[data-testid="cf-type-text"]')
    await page.click('button[type="submit"]')
    await page.waitForSelector('text=Nouveau champ', { state: 'detached', timeout: 8000 })

    const created = db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name=?').get(TABLE, FIELD_NAME)
    assert.ok(created, 'le champ doit exister côté serveur')
    createdFieldId = created.id
    createdColumnName = created.column_name

    const header = page.locator(`[data-testid="col-header-${createdColumnName}"]`)
    await header.waitFor({ timeout: 15000 })

    const renamed = `${FIELD_NAME} renomme`
    await header.dblclick()
    const input = page.locator(`[data-testid="col-rename-${createdColumnName}"]`)
    await input.waitFor({ timeout: 5000 })
    await input.fill(renamed)
    await input.press('Enter')

    let ok = false
    for (let i = 0; i < 20 && !ok; i++) {
      ok = db.prepare('SELECT name FROM custom_fields WHERE id=?').get(createdFieldId)?.name === renamed
      if (!ok) await page.waitForTimeout(300)
    }
    assert.ok(ok, 'le renommage en ligne doit être persisté sans bouton Enregistrer')
  })

  test('duplication : structure + valeurs, posée juste à droite, sans lien externe', async () => {
    const header = page.locator(`[data-testid="col-header-${createdColumnName}"]`)
    await header.hover()
    await page.locator(`[data-testid="col-menu-btn-${createdColumnName}"]`).click()
    await page.locator('[data-testid="colmenu-duplicate-field"]').click()

    let dup = null
    for (let i = 0; i < 25 && !dup; i++) {
      dup = db.prepare('SELECT * FROM custom_fields WHERE erp_table=? AND name LIKE ? AND deleted_at IS NULL')
        .get(TABLE, `${FIELD_NAME} renomme (copie)%`)
      if (!dup) await page.waitForTimeout(300)
    }
    assert.ok(dup, 'la duplication doit créer un champ « (copie) »')
    dupColumnName = dup.column_name
    assert.notEqual(dupColumnName, createdColumnName, 'la copie a sa propre colonne physique')
    assert.equal(dup.source, 'native', 'la copie ne doit hériter d\'aucune source externe')
    assert.equal(dup.airtable_mapping_id ?? null, null, 'la copie ne doit hériter d\'aucun mapping Airtable')

    // Posée juste à droite de l'original, comme dans Airtable.
    await page.locator(`[data-testid="col-header-${dupColumnName}"]`).waitFor({ timeout: 10000 })
    const ids = await page.$$eval('[data-testid^="col-header-"]', els =>
      els.map(e => e.getAttribute('data-testid').replace('col-header-', '')))
    assert.equal(ids[ids.indexOf(createdColumnName) + 1], dupColumnName,
      `la copie doit suivre l'original (ordre: ${ids.join(', ')})`)
  })

  test('suppression sans confirmation, annulable pendant 10 s', async () => {
    const header = page.locator(`[data-testid="col-header-${dupColumnName}"]`)
    await header.waitFor({ timeout: 15000 })
    await header.hover()
    await page.locator(`[data-testid="col-menu-btn-${dupColumnName}"]`).click()
    await page.locator('[data-testid="colmenu-delete-field"]').click()

    // Aucune boîte de dialogue : le champ part directement.
    const dupId = db.prepare('SELECT id FROM custom_fields WHERE erp_table=? AND column_name=?').get(TABLE, dupColumnName)?.id
    let deleted = false
    for (let i = 0; i < 20 && !deleted; i++) {
      deleted = !!db.prepare('SELECT deleted_at FROM custom_fields WHERE id=?').get(dupId)?.deleted_at
      if (!deleted) await page.waitForTimeout(300)
    }
    assert.ok(deleted, 'la suppression doit partir sans confirmation quand le champ n\'a aucune dépendance')

    // …et le toast propose de l'annuler.
    const undo = page.locator('button:has-text("Annuler")').first()
    await undo.waitFor({ timeout: 5000 })
    await undo.click()
    let restored = false
    for (let i = 0; i < 20 && !restored; i++) {
      restored = !db.prepare('SELECT deleted_at FROM custom_fields WHERE id=?').get(dupId)?.deleted_at
      if (!restored) await page.waitForTimeout(300)
    }
    assert.ok(restored, '« Annuler » doit restaurer le champ')
  })

  test('supprimer un champ NATIF le masque partout, sans toucher à sa colonne SQL', async () => {
    await page.reload({ waitUntil: 'networkidle' })
    const first = page.locator('[data-testid^="col-header-"]').first()
    await first.waitFor({ timeout: 20000 })
    const colId = (await first.getAttribute('data-testid')).replace('col-header-', '')
    await first.hover()
    await page.locator(`[data-testid="col-menu-btn-${colId}"]`).click()
    await page.locator('[data-testid="colmenu-delete-field"]').click()

    let hidden = false
    for (let i = 0; i < 25 && !hidden; i++) {
      hidden = db.prepare("SELECT hidden FROM custom_fields WHERE erp_table=? AND column_name=? AND kind='native'")
        .get(TABLE, colId)?.hidden === 1
      if (!hidden) await page.waitForTimeout(300)
    }
    assert.ok(hidden, 'un champ natif supprimé doit être marqué masqué')

    // La colonne disparaît du tableau…
    await page.locator(`[data-testid="col-header-${colId}"]`).waitFor({ state: 'detached', timeout: 8000 })
    // …mais la colonne SQL et les données sont intactes.
    const stillPhysical = db.pragma(`table_info(${TABLE})`).some(c => c.name === colId)
    const known = db.prepare("SELECT 1 FROM custom_fields WHERE erp_table=? AND column_name=?").get(TABLE, colId)
    assert.ok(stillPhysical || known, 'ni la colonne ni sa définition ne doivent disparaître')

    // « Annuler » le remet.
    const undo = page.locator('button:has-text("Annuler")').first()
    await undo.waitFor({ timeout: 5000 })
    await undo.click()
    let back = false
    for (let i = 0; i < 25 && !back; i++) {
      back = db.prepare("SELECT hidden FROM custom_fields WHERE erp_table=? AND column_name=? AND kind='native'")
        .get(TABLE, colId)?.hidden !== 1
      if (!back) await page.waitForTimeout(300)
    }
    assert.ok(back, '« Annuler » doit réafficher le champ natif')
    await page.locator(`[data-testid="col-header-${colId}"]`).waitFor({ timeout: 8000 })
  })
})
